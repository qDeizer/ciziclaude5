# claude-tr-lab

Claude Desktop arayuzunu Turkce'ye cevirmek icin bagimsiz bir yama hatti.
Cizi Code uygulamasina **entegre degildir**; ayri bir calisma alanidir ve
`src/main` altindaki hicbir dosyaya dokunmaz.

## Neden bu yaklasim

Claude Desktop'un kendi i18n sistemi var. Arayuz metinleri iki katalogda yasiyor:

| Katalog | Yol | Anahtar |
|---|---|---|
| main-process | `app/resources/en-US.json` | 487 |
| renderer | `app/resources/ion-dist/i18n/en-US.json` | 20.721 |

Katalog anahtari (`"NA4SBfPMeA"`) **kaynak metnin icerik kimligidir**. 10 dilin
anahtar kumesi birebir aynidir (dogrulandi: sifir sapma). Bunun sonucu:

- Ingilizce metin degismediyse anahtar da degismez → **ceviri calismaya devam eder**
- Ingilizce metin degistiyse anahtar da degisir → o string Ingilizce'ye duser
- Yeni ozellik/yeni string → Ingilizce'ye duser

Yani guncelleme bozulmasi **kismi ve zararsizdir** (graceful fallback). Bu,
minified JS yamalamaktan yapisal olarak daha dayaniklidir: JS dosya adlari
icerik hash'i tasidigi icin her build'de degisir, katalog anahtarlari degismez.

### Iki sinif string

- **Sinif A — cevrilebilir:** `G({defaultMessage, id})` sarmalayicisindan gecenler.
  Katalogda yasarlar. JS'e dokunmadan cevrilir. Isin ~%99'u budur.
- **Sinif B — hardcoded:** duz JS obje haritalarindaki saglayici/marka etiketleri.
  Id'leri yoktur, katalogda yoklar, Anthropic bunlari hicbir dile cevirmez
  (`de-DE.json`'da da Ingilizce kalirlar). Byte yamasi gerekir.
  Ornek: arayuzde sol altta gorunen `Gateway` etiketi.

## Mimari

```
cli.js  (composition root — is mantigi yok, yalnizca baglar)
  |
  +-- claudePackage   kurulu resmi Claude'u bul, kimligini dogrula
  +-- targetScanner   hedefleri BUL (dosya adina/offsete gore DEGIL, anlamsal isarete gore)
  +-- catalogPatcher  katalogu cevir (metin uzerinde cerrahi, JSON yeniden serilestirilmez)
  +-- labelPatcher    JS'e gomulu etiketleri cevir (yalnizca tirnak ici degisir)
  +-- buildService    yamali dosyalari work/<surum>/staged altina STAGE et
  +-- applyService    yedekle -> yazma izni al -> yaz -> dogrula -> izni geri al
```

Her servis tek is yapar. Bagimliliklar `compose()` icinde verilir, dogrudan
olusturulmaz. Loglar stderr'e JSON satiri (`debug|info|success|warning|error`),
komut sonucu stdout'a okunabilir JSON olarak gider.

## Komutlar

Yonetici GEREKMEYEN (hicbir sey degistirmez):

```bash
node cli.js detect     # kurulu Claude'u bul ve dogrula
node cli.js scan       # hedefleri anlamsal olarak tara
node cli.js build      # yamali dosyalari work/<surum>/staged altina uret
node cli.js verify     # canli dosyalarin durumu: patched / original / drifted
node cli.js status     # ozet + siradaki aksiyon
node cli.js launch     # Claude'u baslat
```

Yonetici GEREKEN (makinede degisiklik yapar):

```bash
node cli.js apply --yes                          # yamayi canli kuruluma yaz
node cli.js restore --yes                        # yedekten orijinallere don
node cli.js gateway-on --base-url <URL>          # Claude'u gateway moduna al
node cli.js gateway-off                          # gateway modunu geri al
node cli.js start --base-url <URL>               # tek adim: dogrula + gateway + baslat
```

`gateway-on` icin ek secenekler: `--api-key <KEY>`, `--model <AD>`.
`--debug` tum log seviyelerini acar.

> **Not:** `gateway-on` da yonetici ister. Anahtar `HKCU` altinda olsa bile
> Windows `HKCU\SOFTWARE\Policies` alt agacini standart kullaniciya kapatir.

## Nasil baslatilir (kolay yol)

Masaustundeki **`start.bat`**'a cift tikla. Kendini yonetici olarak yeniden
baslatir (UAC istemi cikar) ve bir menu acar:

```
[1] Durumu goster            (hicbir sey degistirmez)
[2] Yamayi uygula ve gateway modunda baslat
[3] Her seyi geri al
[4] Sadece Claude'u baslat
[5] Cikis
```

Secenek 2 ilk seferde gateway adresini sorar ve hatirlar. Claude acikken
yama yapilamaz; .bat once kapatmayi teklif eder.

`start.bat` hicbir karar vermez: yalnizca yonetici hakki alir, Claude'un
kapali oldugundan emin olur ve `cli.js up` komutunu cagirir. Butun mantik
CLI'da durur.

## Nasil baslatilir (CLI ile)

Yamalanan etiketler (ornegin sol alttaki saglayici adi) **yalnizca Claude
gateway modundayken** render edilir. Bu yuzden test iki on kosul ister:
yama dosyalarda olacak **ve** gateway modu acik olacak.

```
1. Claude'u tamamen kapat (tepsi/tray simgesinden de cik)

2. Yonetici olarak bir terminal ac:
      cd claude-tr-lab
      node cli.js build                             # yamayi uret
      node cli.js apply --yes                       # dosyalara yaz
      node cli.js start --base-url http://127.0.0.1:8787

3. Claude acilir. Sol alttaki saglayici etiketi "Ağ Geçidi" olmali.
```

`start` sirayla sunu yapar: yamanin canli kurulumda oldugunu dogrular ->
gateway modunu acar (oncesini yedekleyerek) -> Claude'u baslatir. Yama
uygulanmamissa `PATCH_NOT_APPLIED` ile durur, yani "basarili" gorunup
sessizce hicbir sey yapmaz.

`--base-url` kendi gateway adresin olmalidir. Amac gateway modu arayuz
durumuna gecmektir; adres calismiyorsa Claude baglanti hatasi gosterir ama
saglayici etiketi yine render edilir.

Her seyi geri almak:

```
node cli.js gateway-off          # gateway modunu geri al
node cli.js restore --yes        # Claude dosyalarini orijinale dondur
```

## Guncelleme akisi

```
Claude guncellendi
   |
   v
status  -> "build-required"   (kurulu surum icin stage edilmis yama yok)
   |
   v
build   -> hedefler yeniden taranir (yeni dosya adlari otomatik bulunur)
           katalog anahtarlari ayni kaldigi icin mevcut ceviriler aynen uygulanir
           degisen/yeni stringler rapor edilir (orphan / kapsam dususu)
   |
   v
apply --yes  -> yedek + yaz + dogrula
```

Sozluk buyudukce yalnizca `dictionary/tr-TR.catalog.json` buyur; kod degismez.

## Guvenlik kurallari

| Kural | Davranis |
|---|---|
| Belirsizlik hatadir | Etiket isareti 0 veya >1 kez bulunursa yama uretilmez (`MARKER_NOT_FOUND` / `AMBIGUOUS_MATCH`) |
| Baglam dogrulamasi | Etiket ancak komsu isaretler (`Claude API`, `Bedrock`, ...) de goruldugunde kabul edilir; enum/config/HTTP kullanimlari yamalanmaz |
| Kaynak sapmasi | Sozlukteki `en` kataloktaki degerle uyusmuyorsa ceviri **uygulanmaz** (`SOURCE_DRIFT`) |
| ICU korumasi | Yer tutucu (`{model}`) veya plural yapisi kaybolursa ceviri **uygulanmaz** |
| Yan etki yok | Cevrilmeyen her anahtarin degeri byte duzeyinde korunur; ihlalde `CATALOG_COLLATERAL_CHANGE` |
| Anahtar kumesi | Sayi veya sira degisirse hata |
| On kosullar | Yonetici hakki, Claude kapali, dosya build'dekiyle ayni (`LIVE_FILE_DRIFTED`) |
| Onay | `apply`/`restore` acik `--yes` olmadan calismaz |
| Geri alma | Herhangi bir adim patlarsa yedekten geri donulur ve aciklikla loglanir |

## Bilinen sinirlar

- **`app.asar` yamalanmiyor.** Ayni saglayici etiketinin 2 kopyasi arsivin
  icinde de var. Arsiv header'i her dosyanin offset+size'ini tutar; uzunluk
  degistiren bir replace paketi bozar ve uygulama acilmaz. Bu yuzden yalnizca
  raporlanir. Renderer yamasi arayuz icin yeterliyse gerek yoktur.
- **Ceviri kapsami tohum seviyesinde.** Sozlukte 63 girdi var (18 main-process,
  45 renderer). Kapsam raporda acikca yazilir; sessizce "tamam" denmez.
- **`en-US` uzerine yazilir.** Yeni bir `tr-TR` locale eklemek yerine mevcut
  Ingilizce katalog cevrilir; boylece locale secim mekanizmasina dokunmak
  gerekmez. Ingilizce'ye donmek icin `restore` kullanilir.
- **Her Claude guncellemesi yamayi siler.** Guncelleme dosyalari orijinaline
  dondurur; `status` bunu `build-required` olarak gorur ve akis tekrar calisir.
- **`work/` git'e girmez.** Stage edilmis dosyalar Anthropic'in kodunu icerir.
