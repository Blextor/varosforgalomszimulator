# Újbuda offline forgalomszimulátor

Pythonban számolt autós és gyalogos ágensszimuláció Budapest XI. kerületének egyszer letöltött OpenStreetMap úthálózatán. A szimuláció futása közben nincs Google Maps-, Overpass- vagy térképcsempe-forgalom: a böngésző kizárólag a helyi Python szerverrel kommunikál.

## Felépítés

- `tools/download_ujbuda_osm.py`: három egyszeri Overpass-lekérdezésből elkészíti a fix, gzipelt úthálózatot és POI-adatbázist.
- `tools/build_route_catalog.py`: a fix gráfhoz egyszer előállítja a sokútvonalas, gzipelt A–B katalógust.
- `tools/analyze_route_usage.py`: hálózati kérés nélkül méri az éllefedettséget, koncentrációt, hurkokat és iránykompatibilitást.
- `traffic_simulator/osm_network.py`: feldolgozza az OSM wayeket, irányokat, sávokat, sebességeket, kanyarodási relációkat és helyszíneket, majd módonként lecsupaszítja a különálló gráfrészeket.
- `traffic_simulator/network_simulation.py`: földrajzilag rétegzett POI-k és főúti peremkapuk közötti A–B útvonalakon mozgatja az autókat és gyalogosokat, sávfolytonossággal, élkapacitással és sávonkénti követési távolsággal.
- `server.py`: külső csomag nélküli HTTP szerver és 30 Hz-es Python szimulációs motor.
- `src/local-map.js`: függőségmentes, nagy teljesítményű Canvas térkép; stabil világkoordináta-LOD-dal ritkítja a POI-kat, nagyításkor pedig kirajzolja a sávokat és a `turn:lanes` nyilakat.
- `src/static-map-worker.js`: a statikus út-, sáv-, kanyarodásinyíl- és POI-réteget főszálon kívül raszterizálja, majd kész bitmapként adja vissza a térképnek.
- `src/replay-buffer.js`: tömör, memóriakorlátos kliensoldali körpuffer az előző 60 másodperc visszajátszásához.
- `src/app.js`: a helyi térkép, vezérlők és állapot-API összekötése.

## Első indítás

Előfeltétel: Python 3.11 vagy újabb. Külső Python-csomag és API-kulcs nem szükséges.

1. Töltsd le és építsd fel egyszer a XI. kerületi hálózatot:

   ```powershell
   python tools\download_ujbuda_osm.py
   ```

   A letöltő a `data\ujbuda_network.json.gz` fájlt hozza létre. Átmeneti Overpass-terhelésnél automatikusan, fokozatos várakozással próbálkozik újra. A szerverindítás később már nem végez letöltést.

   Ha a fő Overpass-példány a harmadik kérésnél rate limitet ad, a POI-k
   külön nyilvános példányról is kérhetők:

   ```powershell
   python tools\download_ujbuda_osm.py --poi-endpoint https://overpass.private.coffee/api/interpreter
   ```

2. A hálózat új letöltése után készítsd el egyszer az útvonalkatalógust:

   ```powershell
   python tools\build_route_catalog.py
   ```

   A mellékelt pillanatképhez a `data\ujbuda_route_catalog.json.gz` már
   rendelkezésre áll. A katalógus a hálózatazonosítóhoz kötött; eltérő vagy
   régi fájlt a szerver nem használ fel.

3. Indítsd el a helyi szervert:

   ```powershell
   python server.py
   ```

4. Nyisd meg:

   ```text
   http://127.0.0.1:8080
   ```

Másik port:

```powershell
python server.py --port 8090
```

Windows alatt a `server.py` egy könnyű felügyelőfolyamatból indítja a tényleges
szervert stabil allokátorral és egy processzormagra korlátozva. Natív
`0xc0000005` leállás után automatikusan újraindítja, a nyitva maradt böngészőlap
pedig újracsatlakozik és újraszinkronizálja a szimulációt. Diagnosztikai A/B
próbához ez kikapcsolható a `UJBUDA_SAFE_RUNTIME=0` környezeti változóval.

## Mit tartalmaz a fix térkép?

- minden XI. kerületi `highway=*` way, a gyalogutakkal együtt;
- irányított élek az `oneway`, `oneway=-1` és körforgalmi irányok alapján;
- `lanes`, `lanes:forward`, `lanes:backward` és becsült hiányzó sávszám;
- `turn:lanes`, `turn:lanes:forward/backward` sávonkénti lehetőségek;
- `type=restriction` relációk, például `no_left_turn` és `only_right_turn`;
- `maxspeed` és irányonkénti sebességcímkék;
- közlekedési lámpa- és gyalogátkelő-csomópontok;
- külön autós, gyalogos és csak gyalogos útszakaszok;
- a fő autós, illetve gyalogos hálózathoz nem csatlakozó komponensek eltávolítása;
- parkolók, üzletek, fodrászatok, bevásárlóközpontok, vendéglátóhelyek, egészségügyi, oktatási és szabadidős helyek;
- busz-, villamos-, vasúti és metrómegállók az OSM régi és új tömegközlekedési címkéiből.

A sávadat OSM-lefedettsége nem teljes. A hiányzó sávszámot a fordító konzervatív alapértékkel egészíti ki; az ilyen adat nem tekinthető hivatalos közútkezelői nyilvántartásnak.

## Hogyan készülnek az A–B utak?

- A kerületet a motor 20×20 földrajzi cellára osztja, így a helyi utcák és nem csak a Duna melletti POI-k kerülnek a célkészletbe.
- A jelenlegi pillanatkép 16 429 POI-jából 5217 autós és 5841 gyalogos szemantikailag alkalmas úticél. A nagy vasút-/metróállomások autós le- és felszállási célként is használhatók, de a platformok és buszmegállók nem válnak autós célponttá.
- A szemantikai vonzerő külön megőrzi a nagy állomásokat, bevásárlóközpontokat, parkokat, kórházakat és egyetemeket. Így Kelenföld, Bikás park és az Etele Plaza nem veszít egy korábbi OSM-azonosítójú kis objektummal szemben.
- A fix katalógus 254 autós és 264 gyalogos horgonyt, valamint 1464, illetve 1584 előre kiszámított A–B utat tartalmaz. A padok, hulladékgyűjtők, parkolóhelyek és hasonló mikrolétesítmények továbbra sem lesznek OD-horgonyok.
- A POI-jelölő a hely tényleges OSM-koordinátáján marad, az ágens viszont a legközelebbi megfelelő úthálózati csomópontnál indul vagy érkezik. A snap-limit autóknál 200 m, gyalogosoknál 120 m; a tényleges távolság az ágens inspectorában látható.
- Az autós kapuk az irányított gráf SCC-frontieréből készülnek. A 14 külön source/sink portál lefedi az M1/M7 csonkját, a Duna-hidakat és a kerülethatáron levágott további nagyobb rendű folyosókat; ugyanazon út néhány tíz méterre levő csomópontjai nem kapnak külön álkaput. A négy gyalogos kapu gyalogutakat, ösvényeket és helyi utcákat részesít előnyben.
- Autó nem használhat gyalogút-jellegű élt. A gyalogos útkeresésből a vasútállomási `platform` és beltéri `corridor` élek ki vannak zárva, így azok nem szolgálnak átmenő rövidítésként.
- Minden életképes origó legfeljebb hat, távolságban, irányban és célponttípusban eltérő célhoz kapcsolódik. Az autós A* menetidőt és kanyarodási költséget, mindkét mód pedig fizikai szegmensenkénti újrahasználati büntetést alkalmaz; a gyalogos A* továbbra is a lakó-, gyalog- és kiszolgáló utakat részesíti előnyben a főutakkal szemben.
- Az A* útvonal belsejében nem használhat zsákutcát megfordulóként. Érkezés után csak az érkezési iránnyal kompatibilis következő út választható; valódi zsákutcacél esetén a visszaút fizikailag kényszerű marad. A kapun kilépő ágens másik source portálon kap új külső utat, nem fordul vissza ugyanazon csonkon.
- A fontos POI-knál rövid tartózkodási idő jelenik meg, ezért az állomások és parkok nem pusztán áthaladási pontok.

## Térképhasználat

- egérgörgő: nagyítás;
- húzás: térkép mozgatása;
- dupla kattintás: teljes XI. kerületre igazítás;
- útszakaszra kattintás: név, sávszám, sebesség, kanyarodási sávok, az összes
  áthaladt autó és az utolsó 60 szimulált másodperc átlagsebessége/terheltsége;
- POI-jelölőre kattintás: név, kategória és fontos OSM-címkék;
- autóra vagy gyalogosra kattintás: a hátralévő A–B útvonal kiemelése (autó:
  narancs, gyalogos: szaggatott cián);
- kategóriagombok: a megjelenített helyszíntípusok ki- és bekapcsolása;
- a 02-es panel visszajátszó csúszkája: korábbi állapot megtekintése vagy 1× szimulációs időben történő lejátszása, majd visszatérés az élő nézethez;
- a két ágensszín-kapcsoló: az autók és gyalogosok egymástól függetlenül válthatók stabil egyedi paletta, illetve egységes narancs/kék megjelenítés között;
- „Útszakasz-terheltség hőtérkép”: az autózható szakaszokat zöld–sárga–piros
  skálán színezi a sebességhatárhoz viszonyított gördülő átlagsebesség alapján,
  az autókat pedig halványítja, hogy a hálózati terhelés maradjon hangsúlyos;
- „Minden részletességi szint előkészítése”: a zoomszintek csempéit külön háttér-workerben előre elkészíti;
- „Teljes kerület előrajzolása”: az aktuális részletességgel a képernyőn kívüli területet is elkészíti, fekete térképszéli margóval;
- nagy nagyításnál: sávelválasztók és kanyarodási nyilak.

A térképi jelmagyarázat külön mutatja az autózható, vegyes és csak gyalogos
szakaszokat. A POI-jelölők fix, méteralapú világkoordináta-rácson kapnak
zoomfüggő ritkítást. Azonos zoomszinten pásztázva ezért ugyanaz a POI marad
egy cella nyertese, nem vibrál a képernyőpixelekhez igazodva.
Maguk a POI-feliratok külön dinamikus Canvas-rétegen, fix 10 képpontos betűmérettel
rajzolódnak újra, ezért nagyítás közben nem skálázódnak együtt a statikus bitmappel.

A pásztázás és zoom alatt a böngésző nem építi újra képkockánként a több tízezer
szegmensből álló `Path2D` hálózatot. A statikus, túlnyúló térképréteg külön
wrapperben marad, az ágenscanvas pedig fölötte önálló kompozitorréteg. A Chrome
mindkettőhöz a saját utolsó forrásnézetéből számított CSS-mátrixot kapja. Közben
az ágensütemező tovább rajzol az aktuális nézet koordinátáival, és minden új
dinamikus képkockával ugyanabban a JavaScript-feladatban visszaállítja a saját
mátrixát identityre. A pontos statikus kép külön `OffscreenCanvas` workerben
készül a húzás végén, illetve 180 ms wheel-nyugalom után. Így a járművek és a
gyalogosok a gesztus alatt is mozognak, miközben a drága úthálózat csak egyszer
raszterizálódik újra. Ha a böngésző nem támogatja ezt az utat, a korábbi
főszálas rajzolás marad biztonsági tartalék. A nem válaszoló háttérrenderelő
2,5 másodperc után automatikusan leáll, így nem hagyhatja beragadt állapotban a
térképet.

Az utak részletessége fokozatosan nő: a fő- és lakóutak mindig látszanak, a
kiszolgáló utak 1,1–1,9×, a legsűrűbb gyalogút-réteg 2,4–3,2× között kapcsolódik
be stabil OSM-way alapú ritkítással. Ez megszünteti a korábbi 1,25× nagyítási
küszöböt, ahol egyetlen képkockában több mint harmincezer gyalogútszakasz jelent
meg. Áttekintő nézetben a közlekedési módot szín jelzi; a drágább szaggatott
raszterezés csak a részletes nézetben marad meg.

Az ágensre kattintva a kiindulási és célhely mellett az útra illesztés
távolsága, illetve a főúti peremkapu-jelleg is megjelenik.

## State adatforgalom

A böngésző a `/api/simulation/state` végpont 2-es protokollját használja. Az
első válasz kulcs nélküli, kvantált teljes ágenslista, utána a kliens az előző
verziószámot küldi vissza, és csak pozíció-, állapot-, hozzáadás- és törlésdelta
érkezik. A kiindulási/cél-POI csak a kijelölt ágenshez kerül a csomagba. Ha egy
válasz kimarad, a verzió nem egyezik vagy a szerver újraindul, a következő kérés
automatikusan teljes állapotot kap. A nagy JSON-válaszok `gzip` level 1
tömörítést használnak, amennyiben a kliens ezt támogatja.

Az útszakaszok gördülő mutatói külön `/api/simulation/segments` végponton érkeznek
1–1,8 másodperces ritmusban, csak amikor a hőtérkép vagy egy szakasz-inspector
igényli őket. Így ezek az adatok nem növelik meg a sűrűn lekért ágens-deltákat.

Futás közben a kliens 3000 ágens alatt 125 ms-os, attól kezdve 200 ms-os,
határidő-alapú ritmusban kér új állapotot; szünetben 750 ms-ra lassít. A kérés
és a feldolgozás idejét levonja a következő várakozásból, és egyszerre legfeljebb
egy kérés lehet folyamatban. Az élő, mozgó autóknál a Canvas a teljes mért
csomagközt kitöltő, korlátozott Hermite-ívvel interpolálja a pozíciót, az
irányszöget pedig az ív érintőjéből számítja. Várakozó vagy áthelyezett
járműnél, gyalogosnál és replay közben lineáris, illetve statikus megjelenítést
használ. Új csomagnál a ténylegesen kirajzolt helyről folytatja a mozgást.
Aktív pásztázás vagy zoom alatt az állapotkérés, a full/delta dekódolás és a
replay-rögzítés is a szokásos ritmusban folytatódik. A statisztika-, vezérlő- és
inspector-DOM frissítéseit a kliens összegyűjti, majd
a gesztus végén egyszer írja ki a legújabb állapotot. A commit nem nullázza az
interpoláció előző pozícióit vagy időalapját, ezért felengedéskor sincs
végállapotba ugrás. Az ágenseket minden zoomon színenként kötegeli, és egy szín
geometriáját csak egyszer építi fel: ugyanazt
a context-pathot tölti ki és körvonalazza, képkockánkénti natív `Path2D`-allokáció
nélkül. Legalább 3000 ágensnél az egyedi színű animáció 1× backing pixelarányt kap,
és csak 2500 alá csökkenve vált vissza, így a küszöb körül nem allokálja újra a
canvast. Normál esetben továbbra is 60 Hz-en frissül, és csak
8 ms fölé kerülő mért rajzolási költségnél vált adaptív 30 FPS-re; a pontos
végállapot-frame mindkét esetben kötelező;
csak a kijelölt ágens készül külön, hogy a kijelölési glória megmaradjon.

Az útvonalkapu miatt új indulópontra helyezett ágenst a delta külön jelöli, így
a Canvas nem interpolálja át a városon. A kliens 250 ms-onként tömör, typed-array
képkockát tesz egy legfeljebb 60 másodperces és 32 MiB-os körpufferbe. A
visszajátszás ezért nem indít további HTTP-kérést; közben az élő state polling a
háttérben folytatódik. A lejátszó a képkockák szimulációs időbélyegét használja:
12 szimulált másodperc 12 valós másodperc alatt, folyamatos interpolációval
játszódik le, függetlenül a rögzítéskori időgyorsítástól.

Az autó megtartja a sávját, amíg az megfelel a következő manővernek; csak
kanyarodási sáv vagy sávszűkülés kényszerít váltást. Ha a kompatibilis sáv
következő rövid OSM-szakaszának belépője foglalt, az autó sorban marad ahelyett,
hogy egy szabad szomszéd sávba, majd rögtön visszaugorna. A 3-ról 2 sávra
szűkülő átmenet a sávok sorrendjét tartja meg, a változatlan 2-ről 2 sávos
folytatás pedig nem kényszerít felesleges váltást. Azonos sáv útvonalán,
egymást követő rövid OSM-éleken és közös cél-sávba történő besoroláskor is
legalább 7,5 méteres modellbeli járműköz marad. A torlódási becslés 40 méteres
útvonalablakot használ, az egyes vezetők szabadforgalmi sebességaránya pedig a
rövid élek között is megmarad.
A piros lámpánál csak az első autó áll a stopvonalhoz, a követők rendezett sort
alkotnak mögötte; egy másik sáv álló járműve nem blokkolja a szabad sávot.
Az ágensjelölők ugyanazt a folytonos zoomfüggő méretszabályt használják az
áttekintő és a részletes nézetben: az autó alacsony zoomon is hosszúkás,
menetirányba álló jelölő,
a gyalogos pedig a POI-khoz arányos, kontrasztos kör marad. Mindkét típus minden
színmódban vékony, sötét körvonalat kap, hogy az egymásra érő ágensek elkülönüljenek.
A pásztázáskor használt úttípus-, sáv-, LOD- és stílusmetaadatok a térkép
betöltésekor egyszer készülnek el. A statikus térképréteg legfeljebb 1×,
az ágensréteg legfeljebb 1,5× eszközpixelsűrűséget használ; így nagy DPI-jű
kijelzőn sem nő négyszeresére mindkét teljes képernyős backing store. A statikus
worker kész `ImageBitmap` képe Chrome-ban `bitmaprenderer` átadással, köztes 2D
`drawImage`-másolás nélkül kerül a látható canvasra; támogatás- vagy futásidejű
hiba esetén automatikusan megmarad a 2D fallback. Ha egy élő state vizuális
ágensadatai változatlanok (például álló sorban), a kliens nem indít hozzá újabb,
üres 60 fps-es interpolációs ciklust.

A két opcionális előkészítési mód alapból ki van kapcsolva, így a jelenlegi
takarékos renderelés marad az alapértelmezés. Bekapcsoláskor egy második worker
512 képpontos, túlnyúlással rajzolt csempéket készít. A gyorsítótár legfeljebb
256 MiB becsült képmemóriát tart meg; a teljes kerület felbontását szükség esetén
ehhez a biztonságos kerethez igazítja. Kikapcsoláskor a worker, a csempék és a
kapcsolódó canvas backing store-ok felszabadulnak. A választás a böngésző helyi
tárolójában megmarad.

5000 ágensnél a mért régi teljes state 1 814 487 bájt volt. Az új gzipelt első
full 75 579 bájt, a 20 egymást követő gzipelt delta átlaga 62 987 bájt lett. A
protokoll nélküli régi teljes válasz kompatibilitási okból változatlanul elérhető.

## Tesztek

```powershell
python -m unittest discover -s tests -v
node tests\test_state_protocol.mjs
node tests\test_simulation_timing.mjs
node tests\test_local_map_timing.mjs
node tests\test_agent_appearance.mjs
node tests\test_replay_buffer.mjs
node tests\test_replay_app_flow.mjs
node tests\test_replay_ui_contract.mjs
node tests\test_static_map_worker.mjs
```

A tesztek hálózati kérés nélkül ellenőrzik többek között az OSM-konverziót, `oneway` irányokat, sávokat, kanyarodási tiltásokat, gráfcsupaszítást, közlekedési módokat, POI-feldolgozást, földrajzi OD-diverzitást, snap-limitet, peremkapukat, rövid élek dinamikus kapacitását, sávfolytonosságot, járműközt, piros lámpás sorokat, relocation-jelzést, replay-időzítést és -memóriakorlátot, UTF-8 HTTP-hibákat, gzip kimenetet, full/delta rekonstrukciót, automatikus resyncet, ágensmozgást és népesség-átméretezést.

A ténylegesen letöltött teljes gráf és az 1000 ágenses teljesítménypróba:

```powershell
python tools\validate_ujbuda_network.py
```

Az útvonalak élhasználati auditja:

```powershell
python tools\analyze_route_usage.py
python tools\analyze_route_usage.py --mode pedestrian --json
```

## Helyi API

| Végpont | Metódus | Feladat |
|---|---:|---|
| `/api/health` | GET | szerver és fix hálózat állapota |
| `/api/network` | GET | gzipelt helyi úthálózat a Canvas számára |
| `/api/simulation/configure` | POST | induló autó- és gyalogosszám |
| `/api/simulation/settings` | POST | ágensszám és időgyorsítás módosítása |
| `/api/simulation/control` | POST | indítás, szünet vagy alaphelyzet |
| `/api/simulation/state` | GET | kompatibilis teljes v1 vagy `protocol=2` esetén verziózott, gzipelt full/delta state |

## Windowsos naplózás

A szerver, a letöltő és a validator induláskor UTF-8-ra állítja a standard
kimenetet és hibakimenetet. A magyar hibaüzenetek az HTTP-válasz UTF-8
törzsébe kerülnek, nem a Latin-1-re korlátozott státuszsorba. Ha a választott
port foglalt, a szerver rövid `Indítási hiba` üzenettel lép ki teljes traceback
helyett.

A szerver HTTP/1.1 kapcsolatot tart fenn, az azonos párhuzamos konfigurációkat
csak egyszer építi fel, a rejtett vagy kapcsolatot vesztett böngészőlapok pedig
ritkábban kérik le az állapotot. Az `error.log` már a nagy hálózat betöltése előtt
bekapcsolja a Python `faulthandler` naplózását, ezért egy natív Windows/Python
összeomlásnál is megmaradhat az utolsó Python stack, PID és életciklus-jelölő.

## Adatforrás és licenc

A térképadat: © OpenStreetMap contributors, Open Database License 1.0. Az attribúció a felületen is látható. A feldolgozott hálózat terjesztésekor az ODbL feltételeit be kell tartani: <https://www.openstreetmap.org/copyright>.

Google Maps tartalom tartós, tömeges offline letöltésére ez a projekt szándékosan nem épít; a fix szimulációs gráf nyílt OSM-adatból készül.

## Modellkorlátok

- Az OSM csomóponti lámpákat tartalmazhat, de valós fázistervet általában nem; a motor szintetikus ciklust használ.
- A letöltés nem tartalmaz élő forgalmi mennyiséget vagy eredet–cél mátrixot; a célpontválasztás az OSM POI-kategóriáiból súlyozott, szintetikus modell.
- A POI-k teljessége és pontossága az OpenStreetMap helyi lefedettségétől függ.
- Valós kalibrációhoz Budapest Közút/BKK számlálási adatok és hivatalos csomóponti programok szükségesek.
- A kerülethatáron kifutó utak a helyi kivágás szélén forgalmi be- és kilépési pontként viselkednek.
