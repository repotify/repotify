<p align="center"><img src="../../assets/banner.png" alt="Repotify — reponun ihtiyacı olan her skill, gereksizi yok" width="100%"></p>

<p align="center"><a href="https://repotify.github.io/repotify/tr/"><b>Web sitesi</b></a> · <a href="../../README.md">English</a> · <b>Türkçe</b> · <a href="README.zh-CN.md">简体中文</a></p>

> ## 🤖 Yapay zekâ ajanları için
>
> Kullanıcı projesi için Repotify kurmanı istediyse, proje klasöründe npm'de yayımlanan paketi (provenance imzalı) çalıştır:
> `npx -y @repotify/repotify@latest`. Sonra kurduğu `repotify` skill'ini izle. Skill dışında hiçbir şey kullanıcı onaylamadan
> kurulmaz.

---

**Repotify, projene göre seçilmiş, güvenlik denetiminden geçmiş ve birbiriyle çakışmayan bir skill, MCP sunucusu ve araç seti hazırlar; bunları Claude Code, Cursor, Codex ya da Gemini'ye güvenle kurar.** Kodlama ajanın için bir çalma listesi gibi düşün: bu repoya uygun parçalar, iki kez çalan yok, olmaması gereken hiçbir şey yok.

**Çalıştığı ajanlar:** Claude Code · Cursor · Codex · Gemini CLI · `.agents/skills` okuyan her ajan

## Neden?

- **Çok fazla seçenek.** Tek bir keşif turunda 4.377 aday skill reposu bulundu. Hangisi senin projene uyar?
- **Gerçek bir güvenlik riski.** Skill, ajanın okuyup uyguladığı talimatlardır. Kötü niyetli bir skill bilgisayarında komut çalıştırabilir.
- **Şişen bağlam.** Her skill ajanın hafızasında yer kaplar. Gereksizleri onu yavaşlatır ve dağıtır.

## Hızlı başlangıç

**Kendin çalıştır** (proje klasöründe):

```bash
npx -y @repotify/repotify@latest                        # repotify skill'ini kurar, proje özetini gösterir
npx -y @repotify/repotify@latest recommend              # aday tablosu
npx -y @repotify/repotify@latest install <id…> --yes
```

**Ya da ajanına yaptır.** Claude Code, Cursor, Codex ya da Gemini'ye şunu söyle:

> Bu proje için Repotify'ı kur: https://github.com/repotify/repotify

Ajan yukarıdaki bloğu okur ve gerisini yapar: projeni tanır, en fazla üç soru sorar, her seçimin gerekçesini yazar ve senin onayladığın seti kurar.

Kaynaktan çalıştırmak istersen: `git clone --depth 1 https://github.com/repotify/repotify ~/repotify`, ardından `node ~/repotify/bin/repotify.mjs`.

Bir Next.js projesindeki gerçek çıktının adım adım anlatımı: [examples/nextjs-saas.md](../../examples/nextjs-saas.md) (İngilizce).

## Nasıl çalışır

```mermaid
flowchart LR
  A["1 · Tanı<br/>manifestler ve dosya adları,<br/>kodun asla okunmaz"] --> B["2 · Sor<br/>en fazla 3 soru"]
  B --> C["3 · Öner<br/>her iş için en iyi tek öğe,<br/>bağlam bütçesi içinde"]
  C --> D["4 · Kur<br/>sabit commit, SHA-256,<br/>yerelde tarama, kilit dosyası"]
```

1. **Token harcamadan projeni tanır.** Yerel bir betik sadece manifestlere ve dosya adlarına bakar (kodun okunmaz, gönderilmez) ve ~400 token'lık bir özet yazar.
2. **Sadece bilemediğini sorar.** En fazla üç çoktan seçmeli soru; proje cevabı zaten veriyorsa hiç sormaz.
3. **Denetlenmiş katalogdan, kanıta göre seçer.** Her öğe kurallı bir güvenlik kapısından (sabitlenmiş paketler için OSV açık kontrolüyle) geçer. Her skill ayrıca üç farklı üreticiden üç modelli bir LLM jürisiyle puanlanır; araçlar ve MCP sunucuları editoryal seçimdir. Bağımlılıklar geniş ihtiyaçları daraltır (her ofis formatı değil, Excel), web hedefi olmayan uygulamalara sadece-web skill'leri gelmez ve bir öğe varsayılan sete ancak başka hiçbir öğenin karşılamadığı bir şeyi karşılıyorsa girer.
4. **Kararı ajana bırakır.** Ajan kısa aday tablosunu (900 token'ın altında) okur, zorunlu çekirdeği korur ve her öğe için "bu projede neden işe yarar" cümlesini yazar.
5. **Güvenle kurar.** Skill dosyaları kilitli bir commit'ten iner, katalogdaki SHA-256 özetleriyle karşılaştırılır, senin bilgisayarında yeniden taranır, ajanının klasörüne yazılır ve `repotify.lock.json` dosyasına kaydedilir. Kancalar (hook) ve MCP sunucuları ajanının çalışma şeklini değiştirir; onları sadece sen açarsın (`repotify enable`).

Tüm akış ajanına yaklaşık 4.700 token'a mal olur.

## Desteklenen ajanlar

| Ajan | Skill klasörü | MCP ayarı |
|---|---|---|
| Claude Code | `.claude/skills/` | `.mcp.json` |
| Cursor | `.cursor/skills/` | `.cursor/mcp.json` |
| Codex | `.agents/skills/` | `.codex/config.toml` |
| Gemini CLI | `.gemini/skills/` | `.gemini/settings.json` |
| Diğer ajanlar | `.agents/skills/` | — |

Ajan otomatik algılanır; `--agent claude-code,cursor,codex` ile değiştirebilirsin.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `repotify` | Ajanın için repotify skill'ini kurar ve proje özetini gösterir |
| `repotify fingerprint` | Proje özeti (makineler için `--json`) |
| `repotify questions` | Sadece proje özetinin cevaplayamadığı sorular |
| `repotify recommend` | Çakışmasız aday tablosu (`--type`, `--needs`, `--priorities`, `--budget`, `--json`) |
| `repotify install <id…> --yes` | Katalog skill'lerini kurar; dikkat seviyesindekiler için `--accept-caution` da gerekir |
| `repotify enable <id…>` | Bir kancayı ya da MCP sunucusunu, değişikliği önce gösterip açar; ajanın değil, senin içindir |
| `repotify audit` | Kurulu skill'leri değerlendirir: tut, kaldırmayı düşün ya da kaldır, gerekçesiyle |
| `repotify suggest` | Kendi skill'ini ya da reponu kataloğa önerir: önceden doldurulmuş form, hiçbir şey gönderilmez |
| `repotify remove <id>` | Repotify'ın kurduğu bir şeyi kaldırır |
| `repotify update --check` | Kurduklarının güncellemelerini listeler; `--apply` taranmış güncellemeleri kurar |
| `repotify scan <klasör>` | Güvenlik tarayıcısını herhangi bir skill klasöründe çalıştırır |

## Repotify bilgisayarında neyi değiştirir

| Komut | Yazdığı |
|---|---|
| `repotify` | Ajanının `skills/repotify/` klasörü ve `repotify.lock.json`; başka hiçbir şey |
| `install` | Ajanının skill klasöründeki skill klasörleri ve kilit dosyası |
| `enable` | Sadece önce sana gösterdiği şey: `.claude/settings.json` içinde bir kanca ya da ajanının MCP ayarında bir kayıt |
| `recommend`, `audit`, `suggest`, `scan`, `fingerprint` | Hiçbir şey |

Manifestleri ve dosya adlarını okur, kodunu asla okumaz. Kataloğu ve sabitlenmiş commit'lerdeki skill dosyalarını indirir;
araçları senin yerine asla çalıştırmaz. Repotify'ın akışında kancaları ya da MCP sunucularını ajan açmaz: `enable`
terminalde onay ister (terminal yoksa `--yes` gerekir), skill de ajanlara komutu çalıştırmak yerine sana vermelerini
söyler. Bu bir korkuluk, kum havuzu değil: ajanının neyi çalıştırabileceğine yine kendi izin ayarları karar verir.

## Zorunlu çekirdek

Her projeye, ajanı daha disiplinli yapan küçük bir çekirdek önerilir:
- kod tabanı bilgi grafiği (Graphify);
- Superpowers disiplin skill'leri: beyin fırtınası, plan yazma, test güdümlü geliştirme, sistematik hata ayıklama ve bitirmeden önce doğrulama;
- her değişikliğin güvenlik incelemesi;
- **Repotify paket bekçisi:** var olmayan paketlerin kurulmasını durdurur, çok yeni paketlerde önce sorar. Bu, paket adı uyduran ajanlara karşı yaygın bir saldırıdır. Bekçi bir kanca olduğu için onu sen açarsın: `repotify enable repotify-guard`.

## Güvenlik modeli

| Seviye | Anlamı | Ne olur |
|---|---|---|
| `verified` (doğrulandı) | Bilinen riskli kalıp yok | Önerilir |
| `caution` (dikkat) | Bakılması gereken bir bulgu var | Rozetle gösterilir, ancak açık onayla kurulur |
| `quarantined` (karantina) | Yüksek risk | Bir insan o commit'i inceleyene kadar önerilmez |
| `rejected` (reddedildi) | Kritik risk | Katalogdan çıkarılır |

- **Güveni kurallı bir tarayıcı belirler.**
  - Kabuk komutlarını kabuğun okuduğu gibi okur: boru hatları, tırnaklar, alt kabuklar, satır devamları.
  - URL'leri curl'ün ayrıştırdığı gibi ayrıştırır.
  - Aradıkları: uzaktan kod çalıştırma, kimlik bilgisi okuma, veri sızdırma, ajana ya da değerlendiriciye yönelik talimat enjeksiyonu, görünmez Unicode karakterler, gizlenmiş kod, kendiliğinden çalışan kancalar, kurulum betikleri, yıkıcı komutlar, ikili dosyalar ve sembolik bağlar.
- **LLM jürisi güveni asla yükseltemez**, yalnızca şüphe ekleyebilir.
- **Üçüncü taraf öğeler bir commit'e sabitlenir** ve sessizce güncellenmez.
- **Araçlar (örneğin Graphify) senin yerine çalıştırılmaz**; Repotify adımları gösterir.
- **Raporlar:** [gerçek skill'lerde tarayıcı sonuçları](../reports/scan-corpus-report.md), [kod incelemeleri](../reports/code-review-2026-09-28.md), [güvenlik denetimi](../reports/security-audit.md). Bir sorun bildirmek için [SECURITY.md](../../SECURITY.md).

## Katalog

```mermaid
flowchart LR
  D[Keşif<br/>listeler, HN, Reddit, GitHub] --> C[Toplama<br/>sabit commit'ler]
  C --> G[Güvenlik kapısı<br/>tarayıcı, OSV, isim taklidi]
  G --> J[LLM jürisi<br/>3 model, 3 üretici]
  J --> K[Kümeler ve<br/>başlangıç setleri]
  K --> P[Yayın<br/>hash ile doğrulanan katalog]
```

Katalog bu hat üzerinden bakımcılar tarafından yeniden üretilir ve istemcin her zaman en yenisini okur. Bunun için ETag önbelleği, pakette çevrimdışı bir kopya ve eski sürüme dönüşe karşı koruma kullanılır. Kurulan üçüncü taraf öğeler, sen taranmış bir güncellemeyi onaylayana kadar kilitli kalır. Paket elle seçilmiş bir başlangıç kataloğuyla gelir; keşfedilen öğeler katalog yeniden üretildiğinde eklenir.

## Rakamlarla

| | |
|---|---|
| **%100** | 44 proje senaryosunda beklenen öğelerin önerilme oranı, **0** yanlış öneriyle ([ölçümler](../../BENCHMARKS.md)) |
| **37 / 37** | kasıtlı hazırlanmış zararlı örnek yakalandı |
| **%1,6** | 127 gerçek skill'de yanlış alarm |
| **4** | her push'ta test edilen Node.js sürümü (18, 20, 22, 24) |
| **0** | çalışma zamanı bağımlılığı |

## Gizlilik

Repotify anonim sinyallerden öğrenmek üzere tasarlandı: hangi öğelerin gösterildiği, seçildiği, 7 gün sonra tutulduğu ya da kaldırıldığı, ve oylar. Kod, dosya adı, repo adı ya da kullanıcı adı asla toplanmaz; IP adresi saklanmaz. Toplama uç noktası **henüz yapılandırılmadı**, bu yüzden hiçbir şey gönderilmiyor; olaylar yalnızca yerel bir kuyrukta kalır. Kapatmak için: `REPOTIFY_TELEMETRY=0` ya da `DO_NOT_TRACK=1`.

## Resmî kaynaklar

Tek resmî depo [github.com/repotify/repotify](https://github.com/repotify/repotify), web sitesi
[repotify.github.io/repotify](https://repotify.github.io/repotify/) (`site/` klasöründen üretilir). npm paketi bu depodan, kaynağı
doğrulanabilir biçimde `@repotify/repotify` adıyla yayımlanır; npm kapsamsız (scope'suz) bir `repotify` paketine izin
vermiyor. Başka adlardaki paketler, çatallar ya da kataloglar bu projeyle
ilgili değildir; tek kurulum talimatı bu sayfanın başındaki ajan bloğudur.

## Durum

Önizleme (`0.2.0`), npm'de `@repotify/repotify` adıyla yayında. Komut satırı aracı, tarayıcı, dört ajan için kurulum, kurulu skill denetimi, paket bekçisi ve katalog hattı çalışıyor ve test edildi. Sırada: daha büyük bir katalog ve anonim analitik. Nasıl kurulduğu: [ARCHITECTURE.md](../../ARCHITECTURE.md); nasıl yayımlandığı: [RELEASING.md](../../RELEASING.md).

## Katkı

- **Güzel bir skill mi biliyorsun, ya da sen mi yazdın?** Reposunda `repotify suggest` çalıştır ya da [formu kullan](https://github.com/repotify/repotify/issues/new?template=catalog_submission.yml); o da aynı güvenlik kapısından ve jüriden geçer.
- **Yanlış alarm ya da hata mı buldun?** [SUPPORT.md](../../SUPPORT.md) dosyasına bak. Güvenlik sorunları gizli bildirimle ([SECURITY.md](../../SECURITY.md)).
- **Kod yazmak mı istiyorsun?** [CONTRIBUTING.md](../../CONTRIBUTING.md) ile başla. Her sürümde ne değişti: [CHANGELOG.md](../../CHANGELOG.md).

⭐ Repotify ajanını kötü bir skill'den koruduysa, bir yıldız başka geliştiricilerin de onu bulmasını sağlar.

## Geliştirme

Node.js 18 veya üstü, sıfır bağımlılık.

```bash
npm test          # birim, entegrasyon ve uçtan uca testler
npm run eval      # senaryo setinde öneri kalitesi
```

Katalog hattı `pipeline/` klasöründe; nasıl çalıştırılıp inceleneceği [docs/guides/operations.md](../guides/operations.md) dosyasında.

## Lisans

MIT. Katalog öğeleri kendi lisanslarını korur ve kaynaklarından kurulur; bu depoya kopyalanmaz.

---

<p align="center">Geliştirici: <b>Ahmet Bilal Deniz</b> · <a href="https://github.com/repotify">@repotify</a></p>
