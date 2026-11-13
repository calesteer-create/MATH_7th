# التصدير الثابت (GitHub Pages)

هذا المستودع يُبنى بوضعين من الكود نفسه، دون نسخة مكرّرة من الصفحات ولا إعادة كتابة:

| الأمر | الناتج | مَن يستخدمه |
|---|---|---|
| `npm run build` | حزمة خادم كاملة (API · لوحة الإدارة · الوسائط · Middleware) | التشغيل المحلي والنشر التقليدي — كما كانت الحال قبل PR 4 |
| `npm run build:static` | تصدير ثابت خام في `out/` تحت `/MATH_7th/` | مدخل بوابة النشر؛ **لا يُرفع كما هو** |
| `npm run pages:prepare` | ينسخ الأجزاء العامة فقط من `out/` إلى `pages-dist/` ويستبعد `admin/` | تجهيز Artifact الرفع |
| `npm run pages:audit` | يفشل عند أي ملف/رابط/محتوى غير مسموح في `pages-dist/` | بوابة الأمان قبل الرفع |
| `.github/workflows/pages.yml` | بناء + تدقيق + نشر من `main` فقط | النشر الفعلي على `https://calesteer-create.github.io/MATH_7th/` |

الوضعان متساويان في الواجهة العامة: الصفحات نفسها، والترجمات نفسها، وقواعد الاتجاه والأرقام نفسها. الفرق الوحيد المقصود هو **الملفات التي لا يمكن أن تعمل بلا خادم**. ملاحظة مهمة: التصدير الخام `out/` ما زال ينسخ `public/admin/` إلى `out/admin/`؛ لذلك لا يُعتبر Artifact النشر. Artifact النهائي هو `pages-dist/` بعد `pages:prepare` و`pages:audit`.

---

## البناء المحلي ومعاينة النسخة الثابتة

```bash
npm ci
npm run build:static    # يُرحّل قاعدة البيانات أولًا (idempotent) ثم next build ثم يكتب out/
npm run pages:prepare   # out/ -> pages-dist/ مع استبعاد admin/ وتدقيق أولي
npm run pages:audit     # إعادة تدقيق Artifact النهائي قبل الرفع
npm run preview:static  # يعاين out/ الخام: http://localhost:4173/MATH_7th/
```

انتبه: `preview:static` يخدم `out/` الخام، لذلك قد يرى `/MATH_7th/admin/` محليًا.
هذا **ليس** Artifact النشر. لمعاينة ما سيُرفع فعلًا، استخدم مجلدًا مؤقتًا يحتوي
`out/` منسوخًا من `pages-dist/` (كما يفعل `tests/pages-artifact.test.ts`)، أو افحص
`pages-dist/` مباشرة. لا ترفع `out/` يدويًا.

`preview:static` يحاكي سلوك مسارات GitHub Pages:

- كل شيء تحت بادئة `/MATH_7th/`؛ الطلب على `/MATH_7th` يعيد توجيهًا 301 إلى `/MATH_7th/`؛
- المسارات المنتهية بـ`/` تُحلّ إلى `index.html` داخل مجلّدها؛
- المسارات غير المعروفة تُجيب `404` من `out/404.html`؛
- ملفات `.txt` (حالة التوجّه المؤقّت للتنقّل في العميل) تُخدَم كـ`text/plain` — وهو ما يقبله عميل Next في وضع التصدير؛
- `out/.nojekyll` يمنع GitHub Pages من تمرير المخرجات على Jekyll (وكان سيتجاهل مجلد `_next/`!).

للتحقّق الآلي الكامل (بما فيه الزحف عبر الروابط) شغّل:

```bash
npm test                # يتضمّن tests/static-export.test.ts و tests/server-mode.test.ts
```

---

## كيف يعمل الوضع المزدوج؟

### 1. ملفات الخادم بلاحقة `.srv`

أي ملف مسار (route) يحتاج خادمًا حيًّا يحمل لاحقة `.srv`:

```
src/proxy.srv.ts                                  ← next-intl middleware
src/app/api/**/route.srv.ts                       ← login · logout · upload
src/app/media/i/[imageId]/[variant]/route.srv.ts  ← خدمة الصور مع فحص الصلاحية
src/app/[locale]/admin/**/page.srv.tsx            ← لوحة المالك + layout.srv.tsx
```

`pageExtensions` في `next.config.ts` يقرّر أي لاحقة تُعدّ مسارًا:

- بناء الخادم: `["tsx", "ts", "srv.tsx", "srv.ts"]` — يرى الكل (كما قبل PR 4)؛
- التصدير الثابت: `["tsx", "ts"]` — الملفات المسبقة `.srv` لا تُكتشف أصلًا، فلا تُجمَع ولا تُصدَّر.

لا حذف ولا تعطيل: الملفات كما هي، ومحتواها يبقى مُتحقَّقًا منه بـ`npm run typecheck` وباختبارات الوضع الخادمي.

### 2. الصفحات العامة: عرض حيّ على الخادم، تثبيت عند التصدير

الصفحات العامة كانت `force-dynamic` — وهي غير متوافقة مع `output: "export"`. البديل:

```ts
// src/lib/render-mode.ts
export function renderPerRequest(): void {
  if (isStaticExport()) return;   // التصدير: تُولَّد مرة واحدة عند البناء
  unstable_noStore();             // الخادم: تُعرض في كل طلب — أي تعديل يظهر فورًا
}
```

كل صفحة عامة تستدعي `renderPerRequest()` في أول سطر. المُعرِّف قرار مبني على علامتين في `src/lib/base-path.ts` (لا على إعدادات الأقسام، لأنها يجب أن تكون ثوابت حرفية). **النتيجة: سلوك الخادم مطابق لما قبل PR 4** — مضمون باختبار `tests/server-mode.test.ts` (محتوى يُضاف بعد البناء يظهر دون إعادة بناء).

### 3. مسارات ديناميكية بلا محتوى

`generateStaticParams()` في صفحتي الوحدة والدرس لا تُعيد قائمة فارغة أبدًا:

- بمحتوى: تُعيد المعرفات الحقيقية (المسودات مستثناة — طلاب لا يرونهَا أبدًا)؛
- بلا محتوى: تُعيد معرّف وهميًا `0` — والصفحة تُجيب `notFound()` له، فلا يُصدَر له سوى قشرة 404 بوسم `noindex` لا يُشار إليها من أي رابط. هذا ليس محتوى وهميًا: هو نفس منطق «العنوان غير موجود» الذي يعمل على الخادم.

السبب موثَّق ومُختبَر: القائمة الفارغة تُصنّف المسار SSG بلا مسارات، فيفشل الطلبات لاحقًا بـ`DYNAMIC_SERVER_USAGE` (HTTP 500) — وهو ما أثبتته الاختبارات قبل الإصلاح وبعده.

### 4. الصفحة الجذرية `out/index.html`

الـ middleware يوجّه `/` ← `/ar` على الخادم؛ في التصدير لا يوجد middleware، فيكتب `scripts/build-static.mjs` صفحة تحويل ثابتة (meta refresh) إلى `/MATH_7th/ar/`.

---

## ما الذي لا يعمل على GitHub Pages؟ (وبماذا يُعوَّض)

| الوظيفة | في التصدير الثابت | البديل |
|---|---|---|
| لوحة الإدارة الخادمية (`src/app/[locale]/admin/**`) | غير مصدَّرة (ملفات `.srv`) | تعمل كما كانت على الخادم؛ لا تغيير |
| لوحة Sveltia التجريبية (`public/admin/`) | ينسخها Next إلى `out/admin/`، لكن `pages:prepare` يستبعدها من `pages-dist/` | لا تُنشر على Pages في هذه المرحلة؛ تبقى للفحص المحلي فقط |
| API (دخول · خروج · رفع) | غير مصدَّر | يعمل على الخادم |
| صور الدروس | **حُلَّت**: التصدير يكتب `/MATH_7th/media/lessons/<lessonId>/<file>.webp` (ملفات ثابتة) بدل مسار الخادم | يختار `src/lib/scan-url.ts` العنوان حسب الوضع، و`scripts/build-static.mjs` ينسخ المنشور فقط عبر `scripts/static-media.mjs`. ما زال `/media/i/…` ممنوعًا في التصدير، و`pages:prepare` يفشل إن ظهر |
| تحديث المحتوى الفوري | ثابت عند البناء | إعادة بناء ونشر عبر `.github/workflows/pages.yml` من `main` |
| ترويسات الأمان `headers()` | لا تعمل (تحذير Next المعروف) | خاص بخادم Node فقط |

**لم يُحذف أي شيء**: قاعدة البيانات، ونظام المصادقة، وحماية `requireOwner`/`assertOwner`، وServer Actions، وMiddleware، وخط أنابيب الصور — كلها موجودة ومُختبَرة في `tests/server-mode.test.ts`.

---

## حدود ومعالجات معروفة

- **تعارض أنواع الوضعين**: `next dev` يكتب مولّد أنواع المسارات في `.next/dev/types` (بما فيه لوحة الإدارة)، وبناء التصدير يولّد `.next/types` مختلفة (الإدارة غير موجودة هناك). اقتران الاثنين في `tsc` يفشل بقيود `Route` متناقضة. المعالجة آليتان: `build:static` يحذف `.next/dev` قبل البناء، و`predev` يحذف `.next/types` قبل تشغيل التطوير — فلا يوجد في أي وقت أكثر من مصدر واحد لأنواع المسارات.
- **تحديث المحتوى على Pages** يتطلب إعادة بناء ونشر. يوجد الآن Workflow نشر رسمي في `.github/workflows/pages.yml`، لكنه لا يقرأ أي مستودع مسودات ولا يستخدم PAT/Secrets؛ يبني من `main` فقط ويدقق Artifact قبل الرفع.
- **الموقع المنشور يُبنى الآن من `content/*.json`، لا من قاعدة البيانات.** قاعدة البيانات المحلية `data/` غير متتبعة في git، ولذلك لا قيمة لها للنشر. راجع `docs/CONTENT_MODEL.md` §8. ما زال الموقع فارغًا لأن الشجرة فارغة، وهذا مقصود حتى تُعتمد أول وحدة.
- **اختبار `/quizzes/unit/[id]`**: زر «اختبار الوحدة» في صفحة الوحدة يشير إلى مسار لم يُبنَ بعد (ميزة المرحلة التالية في README) — سلوك قائم قبل هذا الـالـPR، ولم يتغيّر هنا؛ اختبار الزحف لا يراه لأن الوحدات الجديدة لا تُعلَّم كمكتملة إلا بوجود درس «آخر» منشور.
- **`.srv` لا ينطبق على مكوّنات**: `src/components/admin/*` و`src/app/[locale]/admin/actions.ts` تُستبعد تلقائياً لأن لا صفحة مصدَّرة تستوردها — سلامة ذلك مضمونة بعدّاد الأجراءات في بناء الخادم (13 إجراء) واختبار تنفيذ الإجراء فعليًا.

## خط النشر الآمن (GitHub Pages)

الملف: `.github/workflows/pages.yml`.

- المشغّلات: `push` إلى `main` فقط، و`workflow_dispatch` يدوي. لا يوجد `pull_request`.
  شرطا الوظيفتين `build` و`deploy` يتحققان أيضًا من `github.ref == 'refs/heads/main'`.
- بيئة النشر: `github-pages`، وهي مقيدة في إعدادات المستودع بالفرع `main`.
- التزامن: `concurrency: pages` مع `cancel-in-progress: false` حتى لا يُلغى نشر جارٍ.
- لا PAT، ولا GitHub Secrets، ولا قراءة من مستودع المسودات، ولا كتابة إلى `gh-pages`.
- كل Action رسمي ومثبت على commit SHA تم التحقق منه:
  `actions/checkout@3d3c42e5…` (v7.0.1)،
  `actions/setup-node@949feb24…` (v7.1.0)،
  `actions/upload-pages-artifact@fc324d35…` (v5.0.0)،
  `actions/deploy-pages@368f8252…` (v5.0.1).
- `checkout` يستخدم `persist-credentials: false`.

| الوظيفة/المستوى | الصلاحيات |
|---|---|
| مستوى Workflow العام | `contents: read` |
| `build` | `contents: read` فقط |
| `deploy` | `pages: write` و`id-token: write` فقط |

ترتيب `build`: فحص RTL/الأرقام → تحقق المحتوى الصارم → فحص إعداد الإدارة →
typecheck → الاختبارات الكاملة → `build:static` → `pages:prepare` →
`pages:audit` → رفع `pages-dist/` فقط. الرفع يستخدم
`include-hidden-files: true` لأن `.nojekyll` ملف مخفي، و`retention-days: 1`.
وظيفة `deploy` خطوة واحدة فقط: `actions/deploy-pages`.

### سياسة Artifact

`scripts/pages-artifact.mjs` لا يثق بنجاح البناء وحده:

- الجذور المسموحة: `_next/`, `_not-found/`, `404/`, `ar/`, `en/` والملفات
  `index.html`, `404.html`, `.nojekyll`.
- يستبعد `admin/` الجذري عمدًا، ويفشل عند أي مقطع `admin` أو `api` أو `data`
  أو `media/i` في أي مكان آخر (بما في ذلك حالات الأحرف الكبيرة/الصغيرة).
- يفشل عند أي رابط رمزي، ملف غير عادي، ملف مخفي غير `.nojekyll` الجذري،
  قاعدة بيانات، `.env*`, مفاتيح/شهادات، سجلات، ملفات مصدر/خرائط مصدر، أو امتداد
  غير مدرج في قائمة الأصول الثابتة المسموحة.
- يفشل إذا غاب `.nojekyll` أو `index.html` أو `404.html` أو صفحات اللغتين أو
  أصول `_next/`.
- يفشل عند علامة مستودع المسودات، أو `DRAFT-SECRET-MUST-NOT-APPEAR`، أو أشكال
  توكنات GitHub، أو كتل المفاتيح الخاصة، أو إسنادات الأسرار المعروفة.
- يفشل عند مراجع HTML/CSS إلى `/admin/`, `/api/`, `/media/i/` (مسار الخادم)، أو أي مرجع
  root-absolute خارج `/MATH_7th/` (استثناء واحد: تلميح `preconnect` إلى `/`).
- حد الحجم الكلي 1 GB، وحد الملف النصي الواحد القابل للفحص 32 MiB.

### بعد الدمج: نجاح البناء ليس نجاح النشر

يجب التحقق منفصلًا من:

1. نجاح workflow `GitHub Pages` على `main` (وظيفتا `build` و`deploy`).
2. حالة نشر GitHub Pages الفعلية وآخر deployment.
3. فتح `https://calesteer-create.github.io/MATH_7th/` و`/ar/` و`/en/` وأصل
   `_next/` والتأكد من 200.
4. التأكد من 404 لـ`/MATH_7th/admin/` و`/MATH_7th/api/…` و`/MATH_7th/media/i/…`.

للرجوع: أعد نشر آخر commit معروف جيد من `main`، أو اعكس التغيير على `main`
ودع الخط نفسه ينشر. لا تعدّل ملفات Pages يدويًا.

## الاختبارات

| الملف | ما يثبته |
|---|---|
| `tests/static-export.test.ts` | نجاح التصدير (بمحتوى فارغ ومزروع)، الملفات المتوقعة، لا مسارات خارج `/MATH_7th/`، الأصول والخطوط والـCSS والـJS و`hreflang`، الزحف الكامل للروابط عبر `preview:static`، إخفاء المسودات، صفحات 404، وأن Artifact الحقيقي يستبعد `admin/` والمسارات الخادمية |
| `tests/pages-artifact.test.ts` | بوابة `prepare/audit` على fixtures مؤقتة: استبعاد admin، رفض API/DB/env/المخفي/الروابط الرمزية/المحتوى الحساس/المراجع الخادمية، `.nojekyll` و`_next/`، حدود الحجم، و404 للمسارات الممنوعة عبر خادم يشبه Pages |
| `tests/no-public-write.test.ts` | بنية Workflow: CI للقراءة فقط ولا ينشر، Pages من `main` فقط، صلاحيات النشر محصورة في `deploy`، Actions رسمية مثبتة، لا Secrets/PAT/مستودع مسودات، ولا حفظ اعتماد checkout |
| `tests/server-mode.test.ts` | بناء الخادم وتشغيله: Proxy، RTL/LTR، العرض الفوري بعد الإدخال، 404 والمسودات، الدخول والكوكي و`requireOwner`، الرفع (401/200)، تقديم الصور، تنفيذ Server Action ورفضه بلا جلسة |
| `tests/render-mode.test.ts` | عقد علامات الوضع: `BASE_PATH` و`renderPerRequest()` في الوضعين |
