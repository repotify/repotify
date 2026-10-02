<p align="center"><img src="../../.github/assets/banner.png" alt="repotify: binlerce ajan skill'i, repona uygun olanlar" width="100%"></p>

<h3 align="center">Binlerce ajan skill'i. Repona uygun olanlar.</h3>

<p align="center">Repotify, geliştiricilerin GitHub'da yayınladığı ajan skill'lerini bulur, her birini risklere karşı tarar<br>ve projen için en iyi seçimleri Claude Code, Cursor, Codex veya Gemini CLI'ye kurar.</p>

<p align="center"><a href="../../README.md">English</a> · <b>Türkçe</b> · <a href="README.zh-CN.md">简体中文</a></p>

## Başla

Proje klasöründe:

```bash
npx -y @repotify/repotify@latest
```

Ya da ajanına söyle: **"Bu proje için Repotify'ı kur: https://github.com/repotify/repotify"**

<p align="center"><img src="../../.github/assets/demo.svg" alt="Terminalde Repotify: projeyi okur, her iş için bir öneri seçer, react-native-skills'i dışarıda bırakır ve seçilenleri kurar" width="100%"></p>

## Nasıl çalışır

1. **Okur.** Manifest dosyalarına ve dosya adlarına bakar. Kodun asla okunmaz, hiçbir yere gönderilmez.
2. **Sorar.** En fazla üç kısa soru, sadece projenin cevaplamadığı şeyler için.
3. **Seçer.** Her iş için en iyi skill, MCP sunucusu veya aracı seçer. Katalogdaki her öğe güvenlik taramasından geçmiştir; her skill iki ya da üç yapay zekâ modelinden oluşan bir jüri tarafından puanlanmış ve bir karar modeli tarafından sınıflandırılmıştır.

## Katalog nasıl kurulur

Ajanlar skill'i tek satırlık açıklamasına bakarak seçer. Repotify önce skill'in tamamını okur.

1. **Bulur.** Bir araştırma laboratuvarı GitHub'da ajan skill'leri, MCP sunucuları ve araçlar arar.
2. **Tarar.** Her dosya bir shell'in okuyacağı gibi okunur (gizli indirmeler, anahtar çalma, prompt enjeksiyonu); iki ya da üç yapay zekâ modeli her skill'in kalitesini puanlar.
3. **Sınıflandırır.** Bir karar modeli ([Jev](https://openrouter.ai/docs/guides/community/jev)) her skill'in tam `SKILL.md` dosyasını okur ve beş soruyu olasılıkla cevaplar: yazılım işi mi, tek ana işi ne, hangi dil ya da framework için, tek bir ürüne mi bağlı, bir kere mi, her işte mi, ara sıra mı işe yarar. Repotify'ın kuralları yalnızca emin cevaplarla hareket eder, gerisini bir insana bırakır. 49 elle etiketlenmiş skill'de: ana iş %94 doğru (jürinin serbest etiketleri: %52), dil %100 (%86), konu dışını yakalama %98 (%88).
4. **Eşler.** Cevaplar bir yetenek grafiğine dönüşür: her skill yaptığı işe bağlanır, böylece her işe tek seçim bir tahmin değil bir aramadır.
5. **Seçer.** Projenin manifest dosyaları hangi işlerin gerektiğine karar verir. Her işe denetlenmiş tek skill, bağlam bütçesi içinde; önce elle seçilenler, gerisini laboratuvarın buldukları doldurur. Zaten kurulu olanlar yerini korur.

Sınıflandırıcı katalog kurulurken çalışır; senin API anahtarına ya da model çağrısına ihtiyacın yoktur: `repotify recommend` deterministiktir ve çevrimdışı çalışır.
4. **Kurar.** Her skill sabitlenmiş bir commit'ten gelir, hash'i kontrol edilir ve senin bilgisayarında yeniden taranır. Kancalar ve MCP sunucuları sen açana kadar kapalı kalır.

## Neden Repotify

- **Projene uyar.** Bağımlılıklarında Excel varsa tablo skill'i gelir, Word ve PowerPoint gelmez. Mobil uygulamaya sadece web'e özel skill'ler önerilmez.
- **Şüpheli hiçbir şey giremez.** Her skill bir shell'in ve curl'ün okuyacağı gibi okunur; gizli indirmeler, anahtar çalma ve prompt enjeksiyonu gibi bilinen hileler yakalanır.
- **Şişkinlik yok.** Her iş için bir öğe, bağlam bütçesi içinde. Ajanın hiç kullanmayacağı talimatları taşımaz, hızlı kalır.

## Kurulu olanları temizle

`repotify audit` projende zaten duran skill'lere bakar ve hangisini tutman, hangisini atman gerektiğini gerekçesiyle ve her birinin token maliyetiyle söyler. Hiçbir şeyi silmez.

Bazı skill'ler bir kere işe yarar: kod tabanı haritası ilk gün harikadır, sonra her oturumda açıklamasını, her tetiklendiğinde tüm talimatlarını yüklemeye devam eder. Sınıflandırıcı bunları işaretler (aday tablosunda ⏳) ve iki hafta sonra `audit` işini bitirdiğini söyler.

<p align="center"><img src="../../.github/assets/audit.svg" alt="repotify audit: projeye yarayan skill'leri tutar, başka stack'ler ya da aynı işi yapanlar için kaldırmayı önerir, güvenlik taramasından kalanı işaretler" width="100%"></p>

## Komutlar

| Komut | Ne yapar |
|---|---|
| `repotify` | Projeni okur ve ajanın için repotify skill'ini kurar |
| `repotify recommend` | Bu proje için seçimleri gösterir |
| `repotify install <id…> --yes` | Seçtiğin skill'leri kurar |
| `repotify enable <id>` | Bir kancayı veya MCP sunucusunu, değişikliği gösterdikten sonra açar |
| `repotify audit` | Zaten kurulu olan skill'leri değerlendirir |
| `repotify suggest` | Kendi skill'ini kataloğa önerir |

**Claude Code**, **Cursor**, **Codex**, **Gemini CLI** ve `.agents/skills` okuyan her ajanla çalışır. Tüm komutlar, güvenlik modeli ve gizlilik: [docs/GUIDE.md](../GUIDE.md) (İngilizce).

## Yol haritası

- [x] Kurulu skill'lerin denetimi, kanıta dayalı seçimler, Linux, macOS ve Windows
- [x] Her skill bir karar modeliyle sınıflandırıldı: ana iş, dil, yaşam döngüsü, konu dışı kapısı
- [x] Bir kere işe yarayan skill'ler işini bitirince işaretlenir
- [x] Skill başına yorum yapılabilen web sitesi
- [ ] Büyüdükçe sınıflandırılan, bir yapay zekâ araştırma laboratuvarının sürekli bulduğu daha büyük bir katalog
- [ ] Geliştiricilerin tuttuklarından ve kaldırdıklarından öğrenen sıralama (ölçüm ve öğrenen model hazır; toplama sunucusu henüz çalışmıyor)
- [ ] MCP modu: ajanın Repotify'ı bir araç olarak çağırır

## Katkı

Harika bir skill mi yazdın? Reposunda `repotify suggest` çalıştır. Hata ya da yanlış alarm mı buldun? [Issue aç](https://github.com/repotify/repotify/issues). Kod yazmak mı istiyorsun? [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) ile başla.

---

<p align="center">⭐ Repotify ajanına yardımcı olduysa, bir yıldız başka geliştiricilerin de onu bulmasını sağlar.<br><sub>MIT lisansı · <a href="https://repotify.github.io/repotify/tr/">Web sitesi</a> · <a href="https://www.npmjs.com/package/@repotify/repotify">npm</a> · <a href="../../CHANGELOG.md">Değişiklikler</a> · <a href="../../.github/SECURITY.md">Güvenlik</a></sub></p>
