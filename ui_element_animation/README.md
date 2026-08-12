# Aktif Bağlantı Haritası

Videodaki animasyonun deterministik yeniden inşası. Bağımlılık yok, tek sınıf,
Electron renderer'da doğrudan çalışır (node entegrasyonu gerekmez).

## Kurulum

```html
<link rel="stylesheet" href="baglanti-haritasi.css">
<script src="baglanti-haritasi.js"></script>

<div id="harita"></div>
<script>
  const map = new CiziBaglantiHaritasi(document.getElementById('harita'), { data });
</script>
```

Bundler kullanıyorsan `require('./baglanti-haritasi.js')` da çalışır
(`module.exports` var). CSS'i webpack/vite ile import edebilirsin.

## Veri

```js
{
  provider: { name: 'Cloud', status: 'Bağlı', icon: 'cloud' },
  models:   [{ name: 'Opus 5', meta: '4 model' }, …],
  tools:    [{ name: 'Claude Code CLI', icon: 'cli' }, …],   // icon: 'cli' | 'app'
  links:    [[0, 3], [1, 2], [2, 1], [3, 0]]                 // [modelIndex, toolIndex]
}
```

Provider→model bağlantıları 1:1 örtük. `links` yalnızca model→araç katmanını
tanımlar ve serbest biçimlidir — bir model birden fazla araca bağlanabilir:
`[[0,0],[0,2],[1,1]]`. Kart sayıları veriden gelir, sabit değil.

## API

| Çağrı | Etki |
|---|---|
| `play()` | Animasyonu baştan oynatır |
| `replay()` | Yeniden ölçüp oynatır |
| `settle()` | Bitmiş hâle atlar (kablolar bağlı, enerji akıyor) |
| `reset()` | Boş başlangıç hâli |
| `setData(data, { replay })` | Canlı veri değişimi |
| `destroy()` | Timer/animasyonları iptal eder, DOM'u temizler |

`cbh:settled` olayı kök elementten bubble eder — bağlantılar aktif hâle
geçtiğinde tetiklenir.

## Seçenekler

```js
new CiziBaglantiHaritasi(el, {
  autoplay: true,
  speed: 1,          // 2 = iki kat hızlı, tüm timeline ölçeklenir
  pulseSpeed: 190,    // px/sn — enerji akış hızı
  pulseLength: 26,    // px — akan ışık parçasının boyu
  perf: 'auto',       // 'low' → blur kapanır (zayıf GPU / uzak masaüstü)
  timeline: { settle: 5000 }   // tek tek faz zamanlaması ezilebilir
});
```

## Animasyon akışı

Videodan kare kare çıkarılan ms değerleri (`DEFAULT_TIMELINE`):

```
 260  provider kartı ortadan büyüyerek gelir (scale .4→1, blur 10→0)
 690  kart üzerinde tek seferlik ışık süpürmesi
1780  provider sağ kenarında pin demeti belirir (55ms arayla)
1950  provider→model kabloları uzar (90ms arayla, 1000ms sürede)
2200  model kolonundaki "+" hayalet kutusu söner
2900  model kartları soldan kayarak girer (160ms arayla) — kablo inerken
      kablo kartın kenarına değdiği anda kartta turuncu flaş
3700  model→araç kabloları uzar, ortada kelebek çaprazlaması oluşur
5250  araç kartları önce BOŞ ÇERÇEVE olarak belirir
6100  ardından ikon + etiket + yeşil durum noktası doluşur
7100  sıcak kablolar baz parlaklığına söner, sürekli enerji akışı başlar
      provider çevresinde 4.2sn periyotlu enerji dalgası döngüye girer
```

## Videodan sapılan tek yer: kablo geometrisi

Video AI ile üretildiği için ilk saniyelerde kablolar hedefsiz uzuyor, aynı
`dy` için yukarı çıkan kablo aşağı inenden ~40px geç kıvrılıyor. Burada
görünüm birebir korunup topoloji deterministik kuruldu: kablolar gerçek
anchor noktalarından doğar, gerçek hedefte biter.

Kablonun merkez hattı videodan piksel piksel çıkarılıp şu formüle oturtuldu
(ortalama sapma **2.26 px**):

```
ax = a.x + 14                                   // pinden düz çıkış payı
bx = b.x - 26                                   // hedefe düz giriş payı (daha uzun)
k  = min((bx-ax)/2, max(28, |b.y-a.y| * 0.75))  // kontrol noktası ofseti
M a → L ax → C (ax+k, a.y) (bx-k, b.y) (bx, b.y) → L b
```

Kritik nokta: **kıvrım genişliği yatay mesafeyle değil dikey mesafeyle
ölçekleniyor.** Kontrol noktasını `span`'in yüzdesi olarak kurarsan
(alışılmış "flow curve" yaklaşımı) düz giden kablo gereksiz kıvrılır,
uzağa giden kablo geç ayrılır ve videodaki demet görünümü kaybolur.
`bendRatio`, `bendMin`, `leadIn`, `leadOut` seçeneklerle ayarlanabilir.

Videodaki `links` deseni de doğrulandı: tam ters permütasyon.

## Ölçülen palet

| | |
|---|---|
| panel | `#1b2431` |
| model kartı | `#1e2531` |
| araç kartı | `#131c27` (model kartından koyu) |
| kart kenarı | `#2c3540` |
| kablo | `#f97316` — baz `.72` opaklık, büyürken `#ffb27a` |
| akan ışık | `#ffe3c6`, 26px parça, 190 px/sn |
| durum noktası | `#34d399` |

Kablo profili: 1.6px çekirdek + 7px `blur(4px)` glow katmanı. Kartlar
kabloların üstünde (`z-index` 2), pinler kartların üstünde (3) — kablolar
kartın arkasından geçip kenarda pinle sonlanır.

## Electron notları

- Saf renderer kodu; `contextIsolation: true` ile sorunsuz.
- Kartlar ve kablolar `getBoundingClientRect` ile ölçülür. Panel gizliyken
  (`display:none`) ölçüm 0 döner ve `layout()` sessizce çıkar — sekme
  görünür olunca `map.replay()` çağır.
- `ResizeObserver` pencere yeniden boyutlanınca kabloları yeniden hesaplar;
  animasyon durumu korunur.
- Zayıf GPU veya RDP/uzak masaüstünde `perf: 'low'` ver — SVG blur filtresi
  kapanır, kablo sayısı arttıkça fark açılır.
- `prefers-reduced-motion` açıksa animasyon atlanır, doğrudan bitmiş hâl
  gösterilir.
- CDP ile enjekte ediyorsan: tüm seçiciler `.cbh` altında scope'lu, global
  reset yok, mevcut UI'ya sızmaz. Sınıf adları `cbh__*` öneki taşır.
