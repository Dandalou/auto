# Česko na kolech

Celá Česká republika v prohlížeči, po které se dá jezdit autem a autobusem i chodit pěšky.
Každá budova, silnice, les, řeka, zastávka i adresa pochází ze skutečných dat OpenStreetMap.
Terén je z výškových dat. Svět se stahuje průběžně kolem hráče, takže se dá dojet kamkoli.

**Hrát:** https://dandalou.github.io/auto/

## Co hra umí

- **Celá republika 1:1.** Dlaždice (~1,6 × 1,6 km) se načítají kolem hráče, terén až k horizontu se dotahuje hrubší vrstvou.
- **Skutečné budovy** s výškou z OSM (`render_height`), sedlovými střechami u rodinných domů, okny, která v noci svítí, a kolizemi.
- **Silnice podle třídy** (dálnice, silnice I.–III. třídy, místní, účelové, polní cesty, chodníky, železnice). Mají vodorovné značení, mosty se zvednutou mostovkou a rychlostní limity.
- **Jízda:** dynamický model vozidla s pneumatikami, smykem, ruční brzdou, svahy a skoky přes horizonty. Mimo silnici je horší přilnavost, v dešti a na sněhu auto klouže.
- **Vozidla:** osobní auto, taxi, dodávka, městský a meziměstský autobus, nákladní auto.
- **Chůze:** vystoupíte (E) a jdete pěšky, auto zůstane zaparkované.
- **AI doprava** jezdí po skutečné silniční síti.
- **Práce:**
  - 🚌 Řidič autobusu: linka po skutečných zastávkách MHD s jízdním řádem, otevíráním dveří, nástupem cestujících a hodnocením přesnosti a plynulosti.
  - 🚕 Taxi: vyzvednutí a odvoz na skutečné adresy, taxametr a spropitné.
  - 📦 Rozvoz zásilek na adresy s časovým limitem.
- **Management firmy:** založíte dopravní firmu, stavíte depa, kupujete autobusy, najímáte řidiče a zakládáte linky. Poptávka na lince se odvozuje z obestavěného prostoru budov kolem zastávek. Firma vydělává i ve chvíli, kdy jezdíte jinde, a její autobusy potkáte na silnici.
- **Deník:** navštívená města, obce a osady a statistiky.
- **Mapa celé ČR** s vyhledáváním adres (Nominatim) a přenosem kamkoli.
- **Počasí a čas:** denní doba, roční období (sníh na horách, v zimě všude), déšť, sníh, mlha a oblaka.
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
| J / G / F / M / L | práce / garáž / firma / mapa / deník |
| Esc | nastavení |

## Jak to funguje

```
OpenFreeMap (vektorové dlaždice OSM, z14) ─┐
AWS Terrain Tiles (výšky, Terrarium PNG) ──┼─► Web Worker: terén, budovy, silnice, stromy,
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
- Výškopis [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (SRTM, EU-DEM, GMTED a další zdroje).
- Vyhledávání [Nominatim](https://nominatim.org) (jen na vyžádání hráče).
- Kód je pod licencí MIT (viz `LICENSE`).
