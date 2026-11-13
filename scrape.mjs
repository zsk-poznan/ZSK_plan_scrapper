import fs from "node:fs/promises";

const SCHOOL_HOME_URL = "https://zsk.poznan.pl";
const PLAN_ROOT = "https://zsk.poznan.pl/plany_lekcji/";
const PLAN_LINK_TEXT = /plan\s+zaj[eę]ć|plan\s+lekcji/i;
const CONCURRENCY = 8;
const RETRIES = 3;
const TEACHERS_UNAVAILABLE_REASON =
    "Nauczyciele niedostępni — szkoła ukryła te dane w publicznym planie.";

/** Prefer newest Optivum folders; school often renames e.g. 2026 → 2026_09 → 2026_09_2. */
const CANDIDATE_FOLDERS = (() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const folders = [];
    for (let y = year; y >= year - 1; y -= 1) {
        for (let m = 12; m >= 1; m -= 1) {
            if (y === year && m > month) continue;
            const ym = `${y}_${String(m).padStart(2, "0")}`;
            for (let rev = 5; rev >= 2; rev -= 1) {
                folders.push(`${ym}_${rev}`);
            }
            folders.push(ym);
        }
        folders.push(String(y));
    }
    return folders;
})();

const decodeEntities = (text) =>
    text
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .trim();

const stripTags = (html) => decodeEntities(String(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

const escapeHtml = (text) =>
    String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const fetchText = async (url) => {
    let lastError;
    for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
        try {
            const response = await fetch(url, {
                headers: {
                    "User-Agent": "artmix0-zsk-plan-scraper (https://artmix0.github.io/)",
                    Accept: "text/html",
                },
                signal: AbortSignal.timeout(20000),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} for ${url}`);
            }
            return { html: await response.text(), finalUrl: response.url || url };
        } catch (error) {
            lastError = error;
            if (attempt < RETRIES) {
                await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
            }
        }
    }
    throw lastError;
};

const extractList = (html) => {
    const items = { classes: [], teachers: [], rooms: [] };
    const sections = html.split(/<h4>([^<]+)<\/h4>/i);

    for (let i = 1; i < sections.length; i += 2) {
        const heading = sections[i].trim().toLowerCase();
        const chunk = sections[i + 1] || "";
        const type = heading.includes("oddzia")
            ? "classes"
            : heading.includes("nauczyciel")
              ? "teachers"
              : heading.includes("sal")
                ? "rooms"
                : null;

        if (!type) continue;

        const linkRe = /<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
        let match;
        while ((match = linkRe.exec(chunk))) {
            items[type].push({
                href: match[1],
                name: decodeEntities(match[2]),
            });
        }
    }

    return items;
};

const extractTable = (html) => {
    const tableMatch = html.match(/<table\b[^>]*\btabela\b[^>]*>[\s\S]*?<\/table>/i);
    if (!tableMatch) return null;
    return tableMatch[0].replace(/>\s+</g, "><").trim();
};

const extractTitle = (html, fallback) => {
    const titleMatch = html.match(/<span[^>]*class="tytulnapis"[^>]*>([^<]+)<\/span>/i);
    return titleMatch ? decodeEntities(titleMatch[1]) : fallback;
};

const extractValidFrom = (html) => {
    const match = html.match(/Obowi[aą]zuje od:\s*([\d.]+)/i);
    return match ? match[1] : null;
};

const toAbsoluteUrl = (href, baseUrl) => {
    try {
        return new URL(href, baseUrl).href;
    } catch {
        return `${baseUrl}${href.replace(/^\//, "")}`;
    }
};

const toDirectoryUrl = (href, base) => {
    const absolute = new URL(href, base);
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
        throw new Error(`adres nie jest adresem HTTP: ${absolute.href}`);
    }
    if (/lista\.html$/i.test(absolute.pathname)) {
        absolute.pathname = absolute.pathname.replace(/lista\.html$/i, "");
    }
    if (!absolute.pathname.endsWith("/")) {
        absolute.pathname += "/";
    }
    return absolute.href;
};

const looksLikePlanList = (html) => /<h4>\s*Oddzia/i.test(html) && /plany\/o\d+\.html/i.test(html);

const findPlanHref = (html) => {
    const linkRe = /<a\s+[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
    const fallback = [];
    let match;
    while ((match = linkRe.exec(html))) {
        const href = (match[2] || "").trim();
        const text = stripTags(match[3]).replace(/\s+/g, " ");
        if (!href) continue;
        if (PLAN_LINK_TEXT.test(text)) return href;
        if (href.includes("plany_lekcji/")) fallback.push(href);
    }
    return fallback[0] || null;
};

const tryListAtBase = async (baseUrl) => {
    const listUrl = new URL("lista.html", baseUrl).href;
    const { html } = await fetchText(listUrl);
    if (!looksLikePlanList(html)) {
        throw new Error("nie wygląda na listę Optivum z oddziałami");
    }
    return { baseUrl, listHtml: html };
};

const resolveBaseUrlFromSchoolHome = async () => {
    try {
        const { html, finalUrl } = await fetchText(SCHOOL_HOME_URL);
        const href = findPlanHref(html);
        if (!href) {
            console.log("Na stronie szkoły nie znaleziono linku do planu.");
            return null;
        }
        const baseUrl = toDirectoryUrl(href, finalUrl || SCHOOL_HOME_URL);
        console.log(`Sprawdzam link ze strony szkoły: ${baseUrl}`);
        try {
            const result = await tryListAtBase(baseUrl);
            console.log(`Używam katalogu ze strony szkoły: ${baseUrl}`);
            return result;
        } catch (error) {
            console.log(`Link ze szkoły nie działa (${baseUrl}): ${error.message}`);
            return null;
        }
    } catch (error) {
        console.log(`Nie udało się pobrać strony szkoły: ${error.message}`);
        return null;
    }
};

const resolveBaseUrlFromCandidates = async () => {
    for (const folder of CANDIDATE_FOLDERS) {
        const baseUrl = `${PLAN_ROOT}${folder}/`;
        try {
            const result = await tryListAtBase(baseUrl);
            console.log(`Używam katalogu planu (skan): ${baseUrl}`);
            return result;
        } catch (error) {
            console.log(`Pomijam ${baseUrl}lista.html — ${error.message}`);
        }
    }
    throw new Error(
        `Nie znaleziono działającego planu w ${PLAN_ROOT} (próbowano: ${CANDIDATE_FOLDERS.slice(0, 8).join(", ")}…)`,
    );
};

const resolveBaseUrl = async () => {
    const fromHome = await resolveBaseUrlFromSchoolHome();
    if (fromHome) return fromHome;
    return resolveBaseUrlFromCandidates();
};

const mapWithConcurrency = async (items, mapper) => {
    const results = [];
    let index = 0;

    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (index < items.length) {
            const current = index;
            index += 1;
            results[current] = await mapper(items[current], current);
        }
    });

    await Promise.all(workers);
    return results;
};

const scrapeGroup = async (items, label, baseUrl) => {
    const entries = {};
    const scraped = await mapWithConcurrency(items, async (item, i) => {
        const url = toAbsoluteUrl(item.href, baseUrl);
        const { html } = await fetchText(url);
        const table = extractTable(html);
        if (!table) {
            throw new Error(`Brak tabeli planu dla ${item.name} (${url})`);
        }
        console.log(`[${label} ${i + 1}/${items.length}] ${item.name}`);
        return {
            name: item.name,
            title: extractTitle(html, item.name),
            html: table,
            validFrom: extractValidFrom(html),
        };
    });

    for (const plan of scraped) {
        entries[plan.name] = {
            title: plan.title,
            html: plan.html,
        };
        if (plan.validFrom) {
            entries[plan.name].validFrom = plan.validFrom;
        }
    }
    return entries;
};

const extractCellMatches = (rowHtml) =>
    [...rowHtml.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((match) => match[1]);

const extractLessonsFromClassTable = (tableHtml, className) => {
    const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (rows.length < 2) {
        return { dayHeaders: [], lessons: [] };
    }

    const headerCells = extractCellMatches(rows[0][1]).map((cell) => stripTags(cell));
    const dayHeaders = headerCells.slice(2);
    const lessons = [];

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const cells = extractCellMatches(rows[rowIndex][1]);
        if (cells.length < 3) continue;

        const number = stripTags(cells[0]);
        const time = stripTags(cells[1]).replace(/\s+/g, " ");
        if (!number && !time) continue;

        for (let dayIndex = 0; dayIndex < dayHeaders.length; dayIndex += 1) {
            const cellHtml = cells[dayIndex + 2] || "";
            const chunks = cellHtml.split(/<br\s*\/?>/i);
            for (const chunk of chunks) {
                const subjects = [...chunk.matchAll(/<(?:span|a)[^>]*class="p"[^>]*>([\s\S]*?)<\/(?:span|a)>/gi)].map(
                    (match) => stripTags(match[1]),
                );
                const roomMatch = chunk.match(/<(?:span|a)[^>]*class="s"[^>]*>([\s\S]*?)<\/(?:span|a)>/i);
                const room = roomMatch ? stripTags(roomMatch[1]) : "";
                if (!room || !subjects.length) continue;

                lessons.push({
                    dayIndex,
                    number,
                    time,
                    subject: subjects.join(" "),
                    room,
                    className,
                });
            }
        }
    }

    return { dayHeaders, lessons };
};

const buildRoomsFromClasses = (classes) => {
    let dayHeaders = null;
    const periodMap = new Map();
    const byRoom = new Map();

    for (const [className, entry] of Object.entries(classes)) {
        const tableHtml = typeof entry === "string" ? entry : entry.html;
        if (!tableHtml) continue;

        const parsed = extractLessonsFromClassTable(tableHtml, className);
        if (!dayHeaders && parsed.dayHeaders.length) {
            dayHeaders = parsed.dayHeaders;
        }

        for (const lesson of parsed.lessons) {
            if (!periodMap.has(lesson.number)) {
                periodMap.set(lesson.number, lesson.time);
            }

            if (!byRoom.has(lesson.room)) {
                byRoom.set(lesson.room, new Map());
            }
            const cellMap = byRoom.get(lesson.room);
            const key = `${lesson.dayIndex}|${lesson.number}`;
            if (!cellMap.has(key)) {
                cellMap.set(key, []);
            }
            cellMap.get(key).push({
                subject: lesson.subject,
                className: lesson.className,
            });
        }
    }

    if (!dayHeaders) {
        dayHeaders = ["Poniedziałek", "Wtorek", "Środa", "Czwartek", "Piątek"];
    }

    const periods = [...periodMap.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
    const rooms = {};
    const roomNames = [...byRoom.keys()].sort((a, b) => a.localeCompare(b, "pl", { numeric: true }));

    for (const roomName of roomNames) {
        const cellMap = byRoom.get(roomName);
        let html = `<table border="1" cellspacing="0" cellpadding="4" class="tabela"><tr><th>Nr</th><th>Godz</th>`;
        for (const day of dayHeaders) {
            html += `<th>${escapeHtml(day)}</th>`;
        }
        html += `</tr>`;

        for (const [number, time] of periods) {
            html += `<tr><td class="nr">${escapeHtml(number)}</td><td class="g">${escapeHtml(time)}</td>`;
            for (let dayIndex = 0; dayIndex < dayHeaders.length; dayIndex += 1) {
                const items = cellMap.get(`${dayIndex}|${number}`) || [];
                if (!items.length) {
                    html += `<td class="l">&nbsp;</td>`;
                    continue;
                }
                const inner = items
                    .map(
                        ({ subject, className }) =>
                            `<span class="p">${escapeHtml(subject)}</span> <span class="o">${escapeHtml(className)}</span>`,
                    )
                    .join("<br>");
                html += `<td class="l">${inner}</td>`;
            }
            html += `</tr>`;
        }

        html += `</table>`;
        rooms[roomName] = { title: roomName, html };
    }

    return rooms;
};

const run = async () => {
    const { baseUrl, listHtml } = await resolveBaseUrl();
    console.log(`Pobieram listę: ${baseUrl}lista.html`);
    const { classes, teachers, rooms } = extractList(listHtml);

    console.log(
        `Znaleziono na liście: ${classes.length} klas, ${teachers.length} nauczycieli, ${rooms.length} sal`,
    );

    if (!classes.length) {
        throw new Error("Nie znaleziono klas na lista.html — selektor listy jest nieaktualny.");
    }

    const data = {
        generatedAt: new Date().toISOString(),
        source: baseUrl,
        classes: await scrapeGroup(classes, "klasa", baseUrl),
        teachers: {},
        rooms: {},
        teachersUnavailable: false,
    };

    if (teachers.length) {
        data.teachers = await scrapeGroup(teachers, "nauczyciel", baseUrl);
    } else {
        data.teachersUnavailable = true;
        data.teachersUnavailableReason = TEACHERS_UNAVAILABLE_REASON;
        console.log(TEACHERS_UNAVAILABLE_REASON);
    }

    if (rooms.length) {
        data.rooms = await scrapeGroup(rooms, "sala", baseUrl);
        data.roomsDerivedFromClasses = false;
    } else {
        data.rooms = buildRoomsFromClasses(data.classes);
        data.roomsDerivedFromClasses = true;
        console.log(`Złożono ${Object.keys(data.rooms).length} planów sal z planów klas`);
        if (!Object.keys(data.rooms).length) {
            console.warn("Uwaga: w planach klas nie znaleziono sal (.s) — rooms będzie puste.");
        }
    }

    const classCount = Object.keys(data.classes).length;
    if (classCount < 10) {
        throw new Error(`Za mało planów klas (${classCount}) — przerywam zapis.`);
    }

    const firstClass = Object.values(data.classes)[0];
    data.validFrom = firstClass?.validFrom || null;

    await fs.writeFile("scraped.json", JSON.stringify(data), "utf8");

    const total =
        classCount + Object.keys(data.teachers).length + Object.keys(data.rooms).length;
    console.log(
        `Zapisano ${total} planów do scraped.json (klasy: ${classCount}, nauczyciele: ${Object.keys(data.teachers).length}, sale: ${Object.keys(data.rooms).length})`,
    );
};

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
