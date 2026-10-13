# PETAL store

Цүнх, keychain, бэлгийн хайрцагны онлайн дэлгүүр. Цүнхээ сонгоод keychain-аар чимэж "Look бүтээх", бүх барааг үзэх, бэлгийн хайрцагт бараагаа хийж үзэх, дансаар төлбөр төлөх боломжтой.

- Instagram: https://instagram.com/petal_store_mongolia
- Байршил: https://maps.app.goo.gl/PqRXpycYFpEsSz5c7

## Бүтэц

| Файл | Үүрэг |
|---|---|
| `index-1.html` | Сайт бүхэлдээ (HTML, CSS, JavaScript, зургууд нэг файлд) |
| `_headers` | Cloudflare Pages-ийн аюулгүй байдал, кэшийн тохиргоо |
| `README.md` | Энэ тайлбар |

Build алхам шаардлагагүй, цэвэр статик сайт.

## Cloudflare Pages-д deploy хийх

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Энэ GitHub repo-г сонгоно.
3. Build тохиргоо:
   - Framework preset: **None**
   - Build command: *(хоосон)*
   - Build output directory: `/`
4. **Save and Deploy** дарна. Дуусахад `https://<нэр>.pages.dev` линк гарна.

`main` branch руу шинэ commit push хийх бүрд сайт автоматаар шинэчлэгдэнэ.

## Анхаарах

Сагс, дуртай бараа, үнийн засвар хэрэглэгчийн browser-т (localStorage) хадгалагдана. Захиалгыг серверт хадгалах backend байхгүй тул төлбөрийн дараа худалдан авагч захиалгын текстээ Instagram-аар илгээнэ.
