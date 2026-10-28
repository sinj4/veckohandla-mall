# Veckohandla på mobilen

En liten Cloudflare Worker med en mobilsida, som du kan lägga på hemskärmen som en app:

- **Välj**: veckans förslag som kort. Kryssa i rätterna, ändra ordningen med ↑/↓ (första = måndag) och tryck **Klar**. Sidan startar workflowen med `val`, som gör inköpslistan och korgfilen.
- **Betyg**: förra veckans rätter med 👍/👎 och en valfri kommentar. Sparas i `data/betyg.json` via workflowen (`betyg`).
- **Status**: senaste körningen. När valet är klart visas knappen **📱 Fyll korgen på mobilen**. Den öppnar Willys eller Hemköp med korgen i adressen, och sedan kör du bokmärket eller genvägen Veckohandla ([så installerar du dem](https://github.com/sinj4/veckohandla#fyll-korgen-på-mobilen)).

Sidan läser förslag, planer och korglänkar ur repot via GitHub API och sparar ingenting själv. Den har inga externa beroenden.

## Säkerhet
- **Åtkomst:** varje anrop kräver `?k=<LANKNYCKEL>`. Fel nyckel ger 404, och jämförelsen görs i konstant tid. Mejlens knappar använder i stället en signerad veckolänk (`?v=<vecka>&t=<HMAC>`). Den gäller bara den veckan och veckan efter, och bara för val, betyg och status. Själva nyckeln finns aldrig i mejlet eller i repot.
- **Läckor:** sidan skickar `Referrer-Policy: no-referrer`, så nyckeln följer inte med till GitHub eller butiken. Inget cachas.
- **Begränsning:** högst 10 körningar per timme kan startas, räknat på manuellt startade körningar av workflowen den senaste timmen.
- **Hemskärmsikonen:** den innehåller nyckeln. Tappar du telefonen, byt nyckel (se *Byta nyckel* nedan).

## Installera

Du behöver ett gratis Cloudflare-konto och Node.js (för `npx`).

**1. Skapa en GitHub-token** som bara når det här repot:
GitHub → din profilbild → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
- **Repository access**: *Only select repositories* → `veckohandla-hem`
- **Permissions** → **Repository permissions**: **Actions**: *Read and write*, **Contents**: *Read-only* (Metadata blir *Read-only* automatiskt)
- Välj en giltighetstid och tryck **Generate token**. Kopiera token.

**2. Skapa länknyckeln**, en lång slumpad sträng. Spara den i din lösenordshanterare:
```sh
openssl rand -base64 48 | tr '+/' '-_' | tr -d '='
```

**3. Logga in hos Cloudflare, lägg in hemligheterna och publicera** från den här katalogen:
```sh
cd mobil
npx wrangler login
npx wrangler secret put GITHUB_TOKEN    # klistra in token från steg 1
npx wrangler secret put LANKNYCKEL      # klistra in nyckeln från steg 2
npx wrangler deploy
```
Ändra först `GITHUB_REPO` i `wrangler.toml` till ditt repo, till exempel `ditt-namn/veckohandla-hem`. Första `secret put` frågar om Workern `veckohandla-mobil` ska skapas. Svara ja. `deploy` skriver ut adressen, till exempel `https://veckohandla-mobil.<ditt-konto>.workers.dev`.

**4. Ge workflowen adressen och nyckeln**, så att mejlen får knapparna **Välj rätter** och **Sätt betyg**:
```sh
gh secret set MOBIL_ADRESS -R <ditt-namn>/veckohandla-hem   # adressen från steg 3, utan ?k=
gh secret set LANKNYCKEL -R <ditt-namn>/veckohandla-hem     # samma nyckel som i steg 2
```
Samma sak på webben: repot → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Utan de två visas inga knappar i mejlen, men allt annat fungerar.

**5. Lägg sidan på hemskärmen.** Öppna `https://veckohandla-mobil.<ditt-konto>.workers.dev/?k=<LANKNYCKEL>` i telefonen:
- **iPhone (Safari)**: dela-knappen → **Lägg till på hemskärmen** → **Lägg till**.
- **Android (Chrome)**: ⋮ → **Lägg till på startskärmen** (eller **Installera app**).

Nyckeln följer med i appens startadress, så sidan öppnas direkt från ikonen.

## Byta nyckel
```sh
openssl rand -base64 48 | tr '+/' '-_' | tr -d '='
npx wrangler secret put LANKNYCKEL
gh secret set LANKNYCKEL -R <ditt-namn>/veckohandla-hem
```
Lägg sedan sidan på hemskärmen igen med den nya nyckeln. Gamla länkar och ikoner slutar fungera direkt.

## Tester
```sh
cd mobil && node --test test/*.test.mjs
```
Testerna använder Nodes inbyggda testlöpare och en fejkad `fetch` mot GitHub API, utan nätverk och utan beroenden.
