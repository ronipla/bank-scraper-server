# מחקר עומק — האם israeli-bank-mcp / il-bank-mcp / israeli-bank-connector משדרגים את bank-scraper-server ואת Finami

תאריך: 2026-07-12 · מבוסס על קריאה בקוד עצמו (4 סוכני מחקר), לא על הנחות.

---

## תובנת המפתח
שלושת הפרויקטים החיצוניים **+ השירות שלך** עוטפים את אותו מנוע בדיוק: `israeli-bank-scrapers` (של eshaham).
לכן "יותר בנקים" לא מגיע מהם — הוא מגיע מהספרייה, שכבר יש לך. מה שהם מוסיפים זה **שכבות מעל המנוע**:
ממשק MCP, אחסון, קטגוריזציה, וטיפול ב-2FA. שם צריך להסתכל.

---

## שורה תחתונה
1. **אף אחד מהשלושה לא ייתן "יותר בנקים" בפני עצמו.** הכיסוי הוא של הספרייה. ה-scraper שלך מגדיר 16 מתוך 18. שני החסרים (`pagi`, `oneZero`) לא חסומים על ידם — פשוט לא מוגדרים אצלך, ו-`oneZero` דורש טיפול ב-OTP שהארכיטקטורה שלך לא עושה.
2. **הדבר היחיד שכן פותח בנק חדש הוא טיפול ב-2FA/OTP** — ושם `mottibec` נותן את **התבנית** (לא drop-in): trigger OTP → החלפה ל-long-term token → אחסון → שימוש.
3. **MCP הוא ממשק חדש, לא "שדרוג scraper".** שווה רק אם אתה רוצה שסוכן AI ישאל את הנתונים הבנקאיים בשיחה. שני ה-MCP servers הם `stdio` + קרדנציאל יחיד לתהליך → **לא מתאימים למודל הרב-דיירתי של Finami כמו שהם**.
4. **ה-`israeli-bank-connector` בכלל לא connector** — זה Claude Skill (תיעוד + סקריפט Python אחד), בלי scraping. הערך שלו: מפת קטגוריזציה עברית/אנגלית של סוחרים ישראליים.

---

## טבלת השוואה

| | הסוג | מנוע (`ibs`) | בנקים | אחסון | קטגוריזציה/אנליטיקה | ממשק | 2FA | רב-דיירות | תחזוקה |
|---|---|---|---|---|---|---|---|---|---|
| **bank-scraper-server** (שלך) | מיקרו-שירות REST | **6.7.4** +patch | 16 מוגדרים | ללא (Finami מאחסן) | ללא | REST→Convex | ❌ | ✅ (per-org דרך Finami) | חי, שלך |
| **mottibec/israeli-bank-mcp** | עטיפת MCP דקה | ^6.7.3 (→~6.8.0) | 18 | ללא | ללא | MCP `stdio` | ✅ (טוקן OneZero) | ❌ | 31★, שקט מ-05/26 |
| **glekner/il-bank-mcp** | MCP + מנוע + DB | **^6.1.4 (ישן ממך)** | דינמי | SQLite מקומי | ✅ עשיר (16 כלים) | MCP `stdio` | חלקי | ❌ | 9★, רדום ~13ח', Glama "F" |
| **israeli-bank-connector** | Claude Skill | — (עוטף MCP) | תיעוד 18 | ללא | ✅ regex עברית | Skill + CLI | — | — | פעיל |

**שתי נקודות חדות:**
- **glekner נעול על `6.1.4` — מאחורי ה-6.7.4 שלך.** המנוע שלו נחות משלך; הערך שלו הוא שכבת האנליטיקה בלבד.
- שני ה-MCP servers חסרים לגמרי את חוסן הפרודקשן שכבר בנית: stealth, patch ל-retail3 של דיסקונט, watchdog, canary, מעקפי קריסת Chromium.

---

## פירוט לפי מקור

### 1. bank-scraper-server (שלך)
- Express single-file JS (לא TS), Node ≥22, על Railway עם Chromium headless.
- עוטף `israeli-bank-scrapers@6.7.4` + patch-package אחד ל-Discount retail3 (SPA login).
- 16 מוסדות מוגדרים: 10 בנקים (hapoalim, leumi, discount, mizrahi, mercantile, otsarHahayal, union, beinleumi, massad, yahav) + 4 כרטיסי אשראי (visaCal, max, isracard, amex) + 2 מועדונים (beyahadBishvilha, behatsdaa).
- הספרייה תומכת ב-18; **`oneZero` ו-`pagi` לא מוגדרים** (oneZero דורש OTP).
- REST: `POST /api/scrape/:company` (sync או webhook חתום ב-HMAC ל-Convex בלבד). Bearer key יחיד. **ללא אחסון, ללא dedup, ללא קטגוריזציה** — pass-through ל-Finami.
- אמינות בנויה מבחוץ: GitHub Actions watchdog + canary יומי (login יחיד, בלי retry, למניעת נעילת חשבון), התראות ל-Telegram/Hermes.
- **אין שום MCP.**

### 2. mottibec/israeli-bank-mcp
- עטיפת MCP דקה ב-TypeScript (`src/server.ts` יחיד, ~200 שורות).
- `israeli-bank-scrapers@^6.7.3` (caret → ~6.8.0 = מעודכן ממך).
- **2 כלים**: `fetch-transactions`, `two-factor-auth` (trigger OTP / get-token → מחזיר long-term token). + resource `banks://list`.
- Transport: **stdio בלבד**. קרדנציאלים מ-env vars בלבד (לא מ-args), שגיאות מסוננות.
- 31★, 7 forks, 2 contributors, 6 commits, שקט מ-05/2026. רישיון לא ברור (README אומר MIT, package.json אומר ISC, אין LICENSE).
- **הערך היחיד החדש: transport של MCP + זרימת 2FA (OneZero).** אפס ערך scraping חדש.

### 3. glekner/il-bank-mcp
- Turbo monorepo (Yarn 4): `@bank-assistant/scraper` (מנוע+DB+אנליטיקה) + `@bank-assistant/mcp-server`.
- `israeli-bank-scrapers@^6.1.4` — **ישן משלך.**
- **16 כלים** (README מדווח 8): transactions, financial-summary, accounts, balance-history, recurring-charges, merchant-spending, category-comparison, day-of-week, search, refresh...
- אחסון: **SQLite מקומי** (better-sqlite3). dedup לפי PK על `transactions.id` (מסתמך על identifier מהמנוע — סיכון אם null). נורמליזציה + סיווג הכנסה/הוצאה + זיהוי העברות פנימיות.
- **אין scheduler מובנה** (refresh on-demand בלבד). Transport: **stdio בלבד**. Docker Compose.
- 9★, מחבר יחיד, רדום ~13 חודשים, Glama health "F", רישיון לא ברור.
- **הערך: שכבת אנליטיקה/קטגוריזציה + סכמות הכלים.** לא המנוע (ישן), לא ה-DB (מקומי, לא רב-דיירתי).

### 4. israeli-bank-connector (בשולחן העבודה)
- **לא scraper ולא connector** — Claude Skill (Markdown + סקריפט Python אחד, בלי package.json, בלי scraping). יושב *מעל* שני ה-MCP servers.
- הערך המעשי: מפת **regex עברית/אנגלית של ~40 סוחרים ישראליים** (שופרסל, רמי לוי, רב-קו, פז/סונול/דלק, בזק/פרטנר/סלקום/HOT, כללית/מכבי/מאוחדת, סופר-פארם, הראל/מגדל/מנורה, פנסיה/השתלמות/גמל) ל-9+ קטגוריות. + טבלת בנקים מוערת עם קודי בנק ישראל + "gotchas" של בנקאות ישראלית.
- שווה **לשתול** את שני הנכסים (regex + טבלת הבנקים), לא לאמץ בשלמות.

---

## תשובות לשאלות

### האם שני ה-MCP servers משדרגים את bank-scraper-server?
- **יותר בנקים → לא ישירות.** הכיסוי זהה כי המנוע זהה. כדי להרוויח בנקים: (א) שדרג `ibs` 6.7.4→6.8.0, (ב) הגדר `pagi` (טריוויאלי) ובנה זרימת OTP ל-`oneZero` — ושם mottibec הוא **רפרנס לתבנית**, לא תלות.
- **גישת MCP/סוכן → כן, אבל לא כמו שהם.** ה-MCP הוא היכולת החדשה האמיתית (LLM שואל "כמה הוצאתי החודש על סופר?"). אבל שניהם stdio + קרדנציאל בודד → לא מתחברים למודל של Finami. ל-Finami בונים שכבת **MCP-over-HTTP רב-דיירתית מעל ה-scraper שלך** (התבנית של mottibec = ~200 שורות).

### האם israeli-bank-connector משפר את השירות?
כן, אבל רק כשכבת עזר: **מנוע קטגוריזציה עברית + טבלת בנקים** להשתלה. הוא לא scraper.

### האם זה משדרג את Finami?
שלושה שדרוגים אמיתיים — אף אחד לא דורש לאמץ פרויקט חיצוני שלם:
- **כיסוי בנקים:** OneZero דרך 2FA (תבנית mottibec + שדרוג ibs).
- **קטגוריזציה עברית:** אם Finami/Convex עדיין לא מסווג טוב — regex מה-Skill + מנתחים מ-glekner. *צריך לוודא מה Finami כבר עושה — ה-scraper עצמו לא מסווג כלום.*
- **סוכן פיננסי מבוסס-AI:** שכבת MCP-over-HTTP מעל ה-scraper פותחת feature של "עוזר פיננסי".

---

## המלצה (מדורגת)
1. **אל תחליף את המנוע שלך.** ה-scraper שלך חסין יותר משניהם (glekner אפילו על גרסה ישנה). כולם = מקורות לרעיונות וקוד, לא תחליפים.
2. **זול ומיידי:** שדרג `israeli-bank-scrapers` ל-6.8.0 + הוסף `pagi`. רווח נטו, סיכון נמוך.
3. **ערך גבוה:** שתול את מנוע הקטגוריזציה העברית (regex מה-Skill + מנתחים מ-glekner) — אחרי בדיקה מה Finami כבר עושה.
4. **פרויקט אמיתי אם תרצה AI:** שכבת MCP-over-HTTP רב-דיירתית מעל ה-scraper, בהשראת mottibec, עם טיפול ב-2FA שפותח את OneZero.
