# Česko na kolech

Celá Česká republika v prohlížeči, po které se dá jezdit autem a autobusem i chodit pěšky.
Každá budova, silnice, les, řeka, zastávka i adresa pochází ze skutečných dat OpenStreetMap.
Terén je z výškových dat. Svět se stahuje průběžně kolem hráče, takže se dá dojet kamkoli.

**Hrát:** https://dandalou.github.io/auto/

## Co hra umí

- **Vzhled budov podle RÚIAN**: počet podlaží, využití (rodinný dům, bytový dům, obchod, administrativa, průmysl, garáž), konstrukce (panel, cihla, dřevo) a rok dokončení určují fasádu – historická, moderní, panelová, kancelářská, hala, garáž, roubenka. **Skutečné obchody, restaurace a banky z OSM** mají výlohu a ceduli s názvem, v noci podsvícenou.
- **Letecký snímek jako povrch** (volba v nastavení, ortofoto ČÚZK) místo mapových barev.
- **Skutečné barvy střech** z ortofota ČÚZK: rozpozná pálené tašky, hnědou krytinu, měď, břidlici/plech nebo šedou plochou střechu.
- **Skutečné výšky budov** změřené z ČÚZK (DMP 1G − DMR 5G pod půdorysem), **skutečné počasí** (Open-Meteo) a čas.
- **Přesný terén a vegetace z ČÚZK:** výškopis DMR 5G a stromy tam, kde skutečně rostou. Výška stromu se počítá z výšky porostu (DMP 1G − DMR 5G). Mimo republiku se použije Terrarium a lesy z OSM.
- **Celá republika 1:1.** Dlaždice (~1,6 × 1,6 km) se načítají kolem hráče, terén až k horizontu se dotahuje hrubší vrstvou.
- **Skutečné budovy** s výškou z OSM (`render_height`). Střechy jsou sedlové a valbové nad orientovaným obdélníkem půdorysu, městské bloky dostávají mansardové střechy. K tomu komíny, okna, která v noci svítí, a kolize.
- **Pouliční lampy** v zastavěném území, popisky obcí přímo ve scéně a roční období (podzimní listí, holé stromy v zimě).
- **Silnice podle třídy** (dálnice, silnice I.–III. třídy, místní, účelové, polní cesty, chodníky, železnice). Mají vodorovné značení, mosty se zvednutou mostovkou a rychlostní limity.
- **Jízda:** dynamický model vozidla s pneumatikami, smykem, ruční brzdou, svahy a skoky přes horizonty. Mimo silnici je horší přilnavost, v dešti a na sněhu auto klouže.
- **Vozidla:** osobní auto, taxi, dodávka, městský a meziměstský autobus, nákladní auto.
- **Poškození:** nárazy snižují stav vozidla a výkon, oprava v garáži. Klakson (Q) a pískání pneumatik ve smyku.
- **Palivo:** spotřeba podle vozidla a stylu jízdy, tankování na skutečných čerpacích stanicích z OSM (T).
- **Chůze:** vystoupíte (E) a jdete pěšky, auto zůstane zaparkované.
- **AI doprava** jezdí po skutečné silniční síti a staví na **semaforech** (odvozených na velkých městských křižovatkách). Po chodnících chodí **chodci**.
- **Práce:**
  - 🚌 Řidič autobusu: v Praze a Středočeském kraji jezdíte **skutečné linky PID** se skutečným pořadím zastávek a jízdním řádem (GTFS). Jinde vznikají linky ze skutečných zastávek MHD z OSM. Patří k tomu otevírání dveří, nástup cestujících a hodnocení přesnosti a plynulosti.
  - 🚋 Řidič tramvaje: skutečné tramvajové linky PID, v Brně, Ostravě, Plzni, Olomouci a Liberci linky z tramvajových zastávek OSM. Tramvaj jede po skutečných kolejích, řídí se jen rozjezd, brzdění a dveře.
  - 🚇 Strojvedoucí metra: skutečné linky A, B, C z PID. Tunel vede po skutečné trase z OSM v hloubce pod terénem a ve stanicích má nástupiště a cedule.
  - 🚕 Taxi: vyzvednutí a odvoz na skutečné adresy, taxametr a spropitné.
  - 📦 Rozvoz zásilek na adresy s časovým limitem.
- **Management firmy:** založíte dopravní firmu, stavíte depa, kupujete autobusy, najímáte řidiče a zakládáte linky. Poptávka na lince se odvozuje z obestavěného prostoru budov kolem zastávek. Firma vydělává i ve chvíli, kdy jezdíte jinde, a její autobusy potkáte na silnici.
- **Deník:** navštívená města, obce a osady a statistiky.
- **Mapa celé ČR** s vyhledáváním adres (Nominatim) a přenosem kamkoli.
- **Počasí a čas:** denní doba, roční období (sníh na horách, v zimě všude), déšť, sníh, mlha a oblaka.
- **Sdílení místa** odkazem (`…/auto/#50.08750/14.42050`), fotorežim bez rozhraní (U).
- Ovládání klávesnicí, herním ovladačem i dotykem na mobilu. Postup se ukládá v prohlížeči a jde exportovat.

## Ovládání

| Klávesa | Akce |
|---|---|
| W/S, ↑/↓ | plyn / brzda a couvání |
| A/D, ←/→ | zatáčení |
| Mezerník | ruční brzda (pěšky běh) |
| E | vystoupit / nastoupit |
| O | dveře autobusu |
| C | kamera; myší tažení otáčí, kolečko oddaluje |
| R | zpět na silnici |
| T | natankovat u čerpací stanice |
| Q | klakson |
| U | skrýt rozhraní (fotorežim) |
| J / G / F / M / L | práce / garáž / firma / mapa / deník |
| Esc | nastavení |

## Jak to funguje

```
OpenFreeMap (vektorové dlaždice OSM, z14) ─┐
ČÚZK DMR 5G + DMP 1G (terén, vegetace) ───┤
AWS Terrain Tiles (výšky mimo ČR) ─────────┼─► Web Worker: terén, budovy, silnice, stromy,
                                           │   textura povrchu, kolize, silniční graf, zastávky, adresy
                                           ▼
                         hlavní vlákno: three.js scéna, fyzika, AI, práce, firma, UI
```

- `src/world/tileWorker.ts` staví jednu dlaždici: výškovou mřížku 129×129 a triangulaci budov (earcut). Silnice jsou pásy po terénu, mosty dostávají mostovku z výšky opěr. Kreslí se tam i textura povrchu (OffscreenCanvas), rozmisťují stromy podle lesů a vzniká mřížka kolizí.
- `src/world/world.ts` řídí streamování a uvolňování dlaždic, posouvá počátek scény kvůli přesnosti float32 a odpovídá na dotazy na výšku, mosty a kolize.
- `src/world/roadgraph.ts` skládá silniční síť z dlaždic: navigace A*, nejbližší silnice a rychlostní limity.
- `src/game/` obsahuje vozidla, fyziku, AI dopravu, práce, firmu a ukládání. `src/ui/` obsahuje minimapu a panely.

Souřadnice: Web Mercator na zoomu 14 přeškálovaný pevným faktorem cos(49,8°) na metry.
Každá dlaždice má tak stejnou velikost a v Česku se chyba vůči skutečným metrům drží do ±2 %.

## Vývoj

```bash
npm install
npm run dev      # vývojový server
npm run build    # produkční build do dist/
npm run typecheck
```

Při každém pushi do `main` GitHub Actions hru sestaví a nasadí na GitHub Pages (`.github/workflows/deploy.yml`).

## Data a licence

- Mapová data © [přispěvatelé OpenStreetMap](https://www.openstreetmap.org/copyright), licence ODbL.
- Vektorové dlaždice [OpenFreeMap](https://openfreemap.org) ve schématu [OpenMapTiles](https://openmaptiles.org).
- Barvy střech: Ortofoto ČR © [ČÚZK](https://geoportal.cuzk.gov.cz) (CC BY 4.0).
- Údaje o budovách: RÚIAN © [ČÚZK](https://ruian.cuzk.gov.cz) (stavební objekty, CC BY 4.0).
- Výškopis a vegetace © [ČÚZK](https://geoportal.cuzk.cz) (DMR 5G, DMP 1G, služba ArcGIS ImageServer), licence CC BY 4.0.
- Výškopis mimo ČR: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (SRTM, EU-DEM, GMTED a další zdroje).
- Vyhledávání [Nominatim](https://nominatim.org) (jen na vyžádání hráče).
- Jízdní řády [PID GTFS](https://pid.cz/o-systemu/opendata/) (CC BY 4.0), zpracované skriptem `scripts/build-pid.mjs` při každém nasazení a jednou týdně.
- Aktuální počasí [Open-Meteo](https://open-meteo.com) (CC BY 4.0).
- Kód je pod licencí MIT (viz `LICENSE`).
