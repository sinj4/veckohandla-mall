# Veckohandla i molnet – mall

Mall för att köra [veckohandla](https://github.com/sinj4/veckohandla) i GitHub Actions varje vecka. Varje måndag planerar boten veckans middagar utifrån butikernas kampanjer och mejlar dig rapporten. Planen sparas i ditt repo. Själva varukorgen fylls på din dator med `fyll.sh`, eftersom inloggningen hos Willys eller Hemköp bara finns där.

Det här behövs:
- ett GitHub-konto
- Claude Code med ett Claude Pro- eller Max-abonnemang, eller en Anthropic API-nyckel
- en e-postadress att skicka från (Gmail med app-lösenord fungerar bra)
- en dator med Python 3.12 eller senare, för installationsguiden och för att fylla korgen

## 1. Skapa ditt eget repo från mallen
1. Klicka på den gröna knappen **Use this template** → **Create a new repository** högst upp på den här sidan.
2. Ge repot ett namn, till exempel `veckohandla-hem`.
3. Välj **Private**. Repot kommer att innehålla din config och dina veckoplaner.
4. Klicka på **Create repository**.

## 2. Skapa config.yaml
Det enklaste är att köra installationsguiden på datorn. Den frågar efter butik, hushåll, vad ni inte äter och vart rapporten ska mejlas.
```sh
git clone https://github.com/sinj4/veckohandla ~/veckohandla
cd ~/veckohandla
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/playwright install chromium
.venv/bin/python -m veckohandla init
```
Ladda sedan upp filen till ditt nya repo: öppna repot på GitHub → **Add file** → **Upload files** → välj `~/veckohandla/config.yaml` → **Commit changes**.

Du kan också göra det direkt på GitHub, utan dator:
1. Öppna `config.example.yaml` i ditt repo och klicka på pennan (**Edit this file**).
2. Byt filnamnet i fältet högst upp från `config.example.yaml` till `config.yaml`.
3. Ändra butik, hushåll, `undvik` och e-postadress. Kommentarerna i filen förklarar varje inställning.
4. Klicka på **Commit changes…** och spara direkt till `main`.

Butikens `store_id` hittar du med `python -m veckohandla hitta-willys <ort>` eller `hitta-hemkop <ort>`, eller i installationsguiden.

ICA blockerar automatiska anrop just nu (403). Rätterna och korgen påverkas inte, men ICA-priser jämförs inte. Låt `bara_lokalt: true` stå kvar för ICA-butikerna, så görs inga anrop mot ica.se från molnet.

## 3. Lägg in hemligheterna (secrets)
Hemligheterna läggs aldrig i filer, bara i repots inställningar.

1. Skapa en Claude-token på datorn, där Claude Code är inloggat med ditt abonnemang:
   ```sh
   claude setup-token
   ```
   Kopiera token som skrivs ut.
2. Öppna ditt repo på GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
3. Lägg in de här, en i taget (**Name** och **Secret**, sedan **Add secret**):

| Name | Värde |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | token från `claude setup-token` |
| `SMTP_PASSWORD` | app-lösenordet för mejlet. Gmail: skapa ett app-lösenord på https://myaccount.google.com/apppasswords |
| `ANTHROPIC_API_KEY` | *valfritt, i stället för `CLAUDE_CODE_OAUTH_TOKEN`*: API-nyckel som betalas per token |

## 4. Starta första körningen
1. Öppna repot → **Actions**. Klicka på **I understand my workflows, go ahead and enable them** om GitHub frågar.
2. Välj **Veckohandla** i listan till vänster → **Run workflow** → **Run workflow**.
3. Efter några minuter kommer rapporten med mejlet, och planen sparas i `data/`.

Saknas något stoppar första steget, **Kontrollera config.yaml och secrets**, med ett rött fel som säger vad som fattas.

Samma sak går att göra i **GitHub-appen** på mobilen: öppna repot → **Actions** → **Veckohandla** → **Run workflow**. Fälten i formuläret:
- **onskemal**: valfritt, till exempel "fisk två gånger". Gäller bara den körningen.
- **planera_om**: kryssa i för att göra en ny plan fast veckans redan finns.
- **val**: i valläget (`meny: {lage: val}`) mejlas tio förslag. Skriv numren på de rätter du vill ha, till exempel `2 4 5 8 9`, och kör igen. Då görs inköpslistan och korgfilen för just de rätterna. Ordningen blir måndag–fredag.

Efter det sköter schemat körningen själv varje måndag morgon. GitHub stänger av schemalagda körningar i repon som inte har haft någon aktivitet på 60 dagar, men veckans commit i `data/` räknas som aktivitet.

## 5. Fyll korgen
Korgen fylls på datorn där du är inloggad hos Willys eller Hemköp.

Logga in en gång:
```sh
cd ~/veckohandla && .venv/bin/python -m veckohandla login
```
Klona sedan ditt repo bredvid koden och fyll korgen:
```sh
git clone https://github.com/<ditt-namn>/veckohandla-hem ~/veckohandla-hem
~/veckohandla-hem/fyll.sh             # auto-läget: veckans korg. Valläget: valda rätter, annars förslagen
~/veckohandla-hem/fyll.sh 2 4 5 8 9   # valläget: välj rätter, gör korgen och fyll den direkt
~/veckohandla-hem/fyll.sh --betyg     # betygsätt förra veckans rätter
```
`fyll.sh` hämtar senaste planen med `git pull`. Den lägger bara till det som saknas i korgen och beställer aldrig något. Granska korgen på webbplatsen och beställ själv.

## Felsökning
Kör `python -m veckohandla kontroll` i `~/veckohandla` för en checklista över installationen. Se också felsökningstabellen i [veckohandlas README](https://github.com/sinj4/veckohandla#felsökning).

Workflowen använder senaste versionen av koden från `sinj4/veckohandla`.
