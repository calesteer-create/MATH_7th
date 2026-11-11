# نموذج المحتوى في MATH 7TH — العقد الكامل

> **الحالة:** ساري منذ PR 3 (`arena/00670d9f-math-7th`). يصف النموذج الذي سيعتمده
> الموقع الثابت بعد الترحيل إلى GitHub Pages. **لا يوجد هنا أي محتوى منهاج** —
> هذا عقد بيانات وتحققات، والمحتوى الحقيقي يضيفه مالك المنصة عبر لوحة الإدارة.
> كل مثال يظهر تالياً موسوم بـ«مثال مرجعي» وهو جزء من الاختبارات لا من المنهاج.

## 1. الفكرة

بعد الترحيل لن توجد قاعدة بيانات حية وقت التشغيل. المحتوى بأكمله ملفات JSON داخل
المستودع، والصور نسخ WebP داخل المستودع أيضًا (والأصلية على جهاز المالك فقط).
عند كل نشر، يقرأ GitHub Actions هذه الشجرة، ويتحقق منها، ويبني الموقع الثابت،
وينشره على GitHub Pages. النشر يعني «التزامات على المستودع العام» — لذلك يجب أن
يكون المحتوى قابلًا للمراجعة في الفروقات (diffs) وأن يكون التحقق آليًا وصارمًا.

```
content/
  units/<id>.json              وحدة لكل ملف؛ اسم الملف هو الـ id
  lessons/<id>.json            درس لكل ملف؛ قائمة images مرتبة
  quizzes/lesson-<id>.json     اختبار واحد كحد أقصى لكل درس
  quizzes/unit-<id>.json       اختبار واحد كحد أقصى لكل وحدة
public/
  media/
    lessons/<id>/<file>.webp        صفحات الدرس (WebP فقط)
    lessons/<id>/thumbs/<file>.webp المصغرات (إلزامية لكل صورة)
```

قواعد الأسماء (ينفذها `npm run content:validate`):

- `units/3.json` يجب أن يحمل `id: 3`. ينطبق الشيء نفسه على الدروس.
- **الأسماء canonical دائمًا**: عدد صحيح موجب **دون أصفار بادئة** (`1.json` وليس `01.json`). الاسم غير الـ canonical يُرفض بخطأ `FILENAME_NOT_CANONICAL` ولا يُدمج مع معرّف موجود بصمت أبدًا، واصطدام معرّفين يُبلَّغ بـ `DUPLICATE_ID` مع اسمَي الملفين (السجل الأول يبقى — لا يُسقط أي سجل بصمت).
- ملفات الاختبار `lesson-7.json` يجب أن تكون `scope: "lesson"` و`lessonId: 7`، ويحظر وجود أكثر من اختبار واحد للهدف نفسه (scope + target) عبر فحص `QUIZ_DUPLICATE_TARGET` مهما اختلفت صيغة التسمية.
- اسم ملف الصورة: `^[a-z0-9][a-z0-9-]{0,60}\.webp$` — بلا مجلدات، بلا حروف كبيرة،
  بلا مسافات. هذا يستبعد `../` وأي هروب من مجلد الوسائط بنيويًا.
- `thumb` دائمًا `thumbs/<file>` (مشتق من الاسم — لا مسار حر).
- **`file` اسم مجرّد دائمًا — وما يكتبه Sveltia مسار.** المحرر يحفظ مسار الأصل
  العام (`/media/lessons/3/page-01.webp`) لأن Sveltia تبني القيمة من
  `public_folder` ولا يوجد إعداد يجعلها تُخرج اسمًا مجرّدًا. التوافق يحدث عند
  الحدود: `npm run media:sync` يُطبّع القيمة عبر `canonicalMediaFile`
  (`src/media/naming.ts`) إلى الاسم المجرّد قبل أن يراها المدقّق. لذلك:

  | القيمة المخزَّنة | الحكم |
  |---|---|
  | `page-01.webp` | ✅ canonical — تُترك كما هي |
  | `/media/lessons/3/page-01.webp` | ⚠️ شكل CMS — `media:sync` يطبّعها |
  | `public/media/lessons/3/page-01.webp` | ⚠️ شكل CMS — `media:sync` يطبّعها |
  | `/media/lessons/9/…` داخل الدرس 3 | ❌ رقم درس مختلف — يُرفض، لا تخمين |
  | `../3/page-01.webp` · `%2e%2e%2f…` · `page-01.jpg` | ❌ يُرفض بلا إصلاح |

  المدقّق `content:validate` يبقى **صارمًا** ولا يقبل إلا الشكل الأول؛ القيم
  الأخرى تُبلَّغ بـ`IMAGE_FILE_INVALID` مع إحالة صريحة إلى `media:sync`. وقاعدة
  الاسم المجرّد هي سياج الأمان (لا مسار ⇒ لا هروب)، ولذلك يملك المدقّق كذلك فحص
  احتواء (`IMAGE_PATH_ESCAPES_MEDIA_ROOT`) لا يعتمد على التعبير النمطي وحده.
- **لا كتابة جزئية**: `media:sync` يفحص كل الدروس أولًا، ولا يكتب أي شيء — لا
  JSON ولا مصغّرة — قبل أن يصدر حكمه. إذا تعذّر إصلاح سجل واحد (مسار غريب،
  امتداد غير مدعوم، ملف مفقود) ينتهي التشغيل بالخطأ والشجرة تبقى كما هي
  بايت-بايت. المصغّرات تُكتب قبل JSON في المرور الناجح لأن السجل المؤقت يفترض
  وجودها. `--dry-run` لا يكتب شيئًا في كل الأحوال.
  ومرحلة الكتابة نفسها محميّة أيضًا: الحكم النظيف ليس معاملة (transaction). إذا
  فشلت كتابة — سجل للقراءة فقط، قرص ممتلئ، صلاحيات — تُلغى كل الملفات التي
  أنشأها التشغيل وتُعاد بايتات كل ملف استُبدل، فتبقى الشجرة كما وُجدت بدل أن
  تبقى «مطبَّعة مع مصغّرة لا يشير إليها أحد». وكتابة `JSON` ذرّية (ملف مؤقت ثم
  `rename`)، فلا يمكن أن يبقى سجل مقتطع في منتصفه. والتراجع نفسه محصور في
  شجرتَي المحتوى والوسائط: أي مسار خارجها يُرفض ولا يُحذف. وإن تعذّر التراجع
  يُعلن التشغيل `ROLLBACK INCOMPLETE` مع سبب كل ملف، ولا يدّعي أن الشجرة كما
  كانت.
- **لا اتباع للروابط الرمزية**: كل كتابة وحذف واستعادة تمرّ عبر `resolveInside`
  الذي يفحص كل مكوّن تحت الجذر بـ`lstat` ويرفض أي `symlink` — مجلدًا كان أو
  ملفًا. الاعتماد على `path.resolve`/`startsWith` وحدهما لا يكفي لأن النواة
  تتبع مكوّن مجلد رمزي في `open` و`rename`، و`realpath` فحصٌ يسبق الكتابة لا
  يمنع تبديل الرابط بينهما. لذلك يُرفض المكوّن الرمزي نفسه، ويُفتح الملف بـ
  `O_NOFOLLOW` (`O_EXCL` للملف المؤقت)، ويُعاد الفحص قبل `rename`. ما يبقى خارج
  الجذر يبقى مطابقًا بايتًا ببايت. القاعدة نفسها مطبَّقة في `media:import`
  (`writeFileInside`) وفي مخزن الرفع (`src/lib/storage-safe.ts`)، فالدالة
  المكتبية آمنة عند استدعائها مباشرة لا عبر الـCLI فقط.
- **سياسة الجذر**: الجذر نفسه (أو أحد آبائه) قد يكون رابطًا رمزيًا — المشغّل
  يختاره صراحةً، و`/tmp` على macOS كذلك — فيُحلّ بـ`realpath` ويبدأ المشي من
  المجلد الحقيقي. كل ما **تحت** الجذر يجب أن يكون حقيقيًا؛ ولا يُقبل خلط
  التسميتين (هدف مكتوب بمسار الجذر الحقيقي مع جذر رمزي ⇒ مرفوض).
- **حدود الضمان**: هذا يمنع الروابط الرمزية **الموجودة مسبقًا** (رابط في
  المستودع، أو أنشأه تشغيل سابق، أو زرعه من يملك الكتابة في شجرة الوسائط).
  أما تبديل مكوّن مجلد **بالتزامن** بين الفحص والاستخدام فلا يمنعه هذا الـAPI:
  Node لا يوفّر `openat` نسبيًا إلى dirfd، لذا `lstat` + إعادة الفحص يضيّقان
  النافذة ولا يسدّانها. المكوّن الأخير محميّ من النواة بـ`O_NOFOLLOW`.
- `sha256` لكل صورة WebP، lowercase hex بطول 64 — بصمة سلامة للملف كما هو مخزّن.

## 2. حقول الوحدة — `content/units/<id>.json`

| الحقل | النوع | إلزامي | القيد |
|---|---|---|---|
| `id` | integer ≥ 1 | ✅ | يساوي اسم الملف |
| `position` | integer ≥ 1 | ✅ | فريدة على مستوى كل الوحدات |
| `titleAr` | string | ✅ | غير فارغ، ≤ 200 حرف |
| `titleEn` | string | ✅ | يمكن أن تكون `""`، ≤ 200 |
| `descriptionAr` | string | ✅ | يمكن `""`، ≤ 1000 |
| `descriptionEn` | string | ✅ | يمكن `""`، ≤ 1000 |
| `pageFrom` / `pageTo` | string | ✅ | يمكن `""`، ≤ 20 (تقبل تنسيق أي طبعة) |
| `accent` | string | ✅ | واحد من: `teal sky indigo violet rose amber emerald cyan` |
| `createdAt` / `updatedAt` | ISO-8601 UTC | ✅ | `2026-11-01T10:00:00.000Z` |

ملاحظات: الوحدات **ليس لها حالة نشر** (كما في التصميم الحالي)؛ الوحدة تظهر في الموقع
إذا كان فيها درس منشور واحد على الأقل. الترتيب يدار بـ `position` يدويًا.

## 3. حقول الدرس — `content/lessons/<id>.json`

| الحقل | النوع | إلزامي | القيد |
|---|---|---|---|
| `id` | integer ≥ 1 | ✅ | يساوي اسم الملف |
| `unitId` | integer ≥ 1 | ✅ | يجب أن يشير لوحدة موجودة |
| `position` | integer ≥ 1 | ✅ | فريدة داخل الوحدة الواحدة |
| `titleAr` | string | ✅ | غير فارغ، ≤ 200 |
| `titleEn` | string | ✅ | يمكن `""` |
| `pageLabel` | string | ✅ | يمكن `""`، ≤ 100 (مثل «ص 24–29») |
| `status` | `draft` \| `published` | ✅ | المسودة لا تُبنى في الموقع العام |
| `isLastInUnit` | boolean | ✅ | على الأكثر `true` واحد لكل وحدة |
| `publishedAt` | ISO \| null | ✅ | إلزامي غير-null إذا `status=published` |
| `contentUpdatedAt` | ISO-8601 | ✅ | يتحدث مع كل تغيير محتوى (أساس staleness) |
| `createdAt` / `updatedAt` | ISO-8601 | ✅ | |
| `images` | array | ✅ | يمكن `[]`؛ إلزامية صورة واحدة إذا `published` |

### حقول صورة الدرس — عناصر `images`

| الحقل | النوع | إلزامي | القيد |
|---|---|---|---|
| `position` | integer ≥ 1 | ✅ | فريدة داخل الدرس |
| `file` | string | ✅ | الاسم المجرد (`page-01.webp`) — WebP فقط |
| `thumb` | string | ✅ | `thumbs/<file>` حصرًا |
| `width` / `height` | integer ≥ 1 \| null | ⛔ | ≤ 100000 |
| `bytes` | integer ≥ 1 \| null | ⛔ | حجم الرفع الأصلي (معلوماتي) |
| `sha256` | string | ✅ | 64 حرف hex |

الصور تُرتب بـ `position` في المصفوفة نفسها؛ لا يوجد حقل `order` منفصل.

## 4. حقول الاختبار — `content/quizzes/<scope>-<id>.json` (للمراحل القادمة)

نفس دلالات مخطط SQLite الحالي، بثلاثة تعديلات تبسّط التنسيق النصي:

1. **هوية الاختبار من اسم الملف** — لا يوجد `id` رقمي للاختبار نفسه؛
   `lesson-7.json` هو بالضبط «اختبار الدرس 7» (يفرض قيد التفرد كما كانت
   `uq_quiz_lesson` / `uq_quiz_unit`).
2. **هوية النسخة هي `versionNumber`** — لا يوجد معرف رقمي للنسخة؛
   و`activeVersion` يشير إلى `versionNumber`.
3. **`isLastInUnit` و`needsReview` قيم منطقية** (كانت 0/1) — أوضح في JSON.

| الحقل | النوع | إلزامي | القيد |
|---|---|---|---|
| `scope` | `lesson` \| `unit` | ✅ | يطابق اسم الملف |
| `lessonId` | integer \| null | ✅ | إلزامي ووحده غير-null عند `scope=lesson` |
| `unitId` | integer \| null | ✅ | إلزامي ووحده غير-null عند `scope=unit` |
| `status` | `idle` \| `generating` \| `draft` \| `published` \| `stale` \| `failed` | ✅ | |
| `activeVersion` | integer \| null | ✅ | يشير إلى `versionNumber` موجودة |
| `sourceFingerprint` | string | ✅ | `""` أو 64 hex (انظر §5) |
| `lastError` | string \| null | ✅ | سبب آخر فشل توليد |
| `createdAt` / `updatedAt` | ISO | ✅ | |
| `versions` | array | ✅ | يمكن `[]` |

### `versions[]`

| الحقل | النوع | قيد |
|---|---|---|
| `versionNumber` | integer ≥ 1 | فريدة داخل الاختبار |
| `status` | `draft` \| `approved` | |
| `provider` / `model` | string | يمكن `""`، ≤ 120 |
| `notes` | string | يمكن `""`، ≤ 2000 |
| `generatorLog` | string[] | يمكن `[]`، ≤ 500 سطر |
| `createdAt` / `approvedAt` | ISO \| null | `approvedAt` عند الاعتماد |
| `questions` | array | ≤ 100 سؤالًا |

### `versions[].questions[]`

| الحقل | النوع | قيد |
|---|---|---|
| `position` | integer ≥ 1 | فريدة داخل النسخة |
| `type` | string | غير فارغ ≤ 50 — أمثلة موثقة: `mcq`, `numeric`, `essay`, `true_false`, `matching` |
| `promptAr` | string | غير فارغ (≤ 2000) |
| `promptEn` | string | يمكن `""` |
| `parts` | array | حرة البنية (خيارات، أزواج مطابقة…) |
| `answer` | object | البنية تتبع `type`؛ قابلة للفحص الآلي حسب `gradingMode` |
| `explanationAr` / `explanationEn` | string | يمكن `""` (≤ 4000) |
| `points` | integer ≥ 1 | |
| `gradingMode` | `auto_exact` \| `auto_numeric` \| `self_assessed` | `self_assessed` = لا يزعم النظام التصحيح، يعرض الحل النموذجي ويترك التقييم للطالب |
| `sourceImage` | string \| null | إن وُجد يجب أن يكون `file` صورة **ضمن المحتوى المُقيَّم** (درس scope=lesson؛ كل دروس الوحدة scope=unit) |
| `sourceRef` | string | يمكن `""` (≤ 200) — مثال: «صفحة 41» |
| `confidence` | string | الافتراضي `unverified` |
| `needsReview` | boolean | الافتراضي `true` — كل سؤال مولّد يحتاج مراجعة بشرية أولًا |

## 5. بصمة المصدر `sourceFingerprint`

اكتشاف تقادم الاختبار بعد تعديل صور الدرس:

```
fingerprint = sha256( lines.join("\n") )
lines = images (مرتبة حسب position تصاعديًا) .map( i => `${i.sha256}:${i.position}` )
```

- تغيير ترتيب المصفوفة دون تغيير الصور لا يبدّل البصمة (الترتيب داخل الخوارزمية تصاعدي دائمًا).
- إضافة/حذف/استبدال أي صورة = بصمة جديدة ⇒ الاختبار يصبح *stale* (تحذير
  `QUIZ_SOURCE_STALE` في التحقق وليس فشلًا — لأن التقادم قرار بشري).
- `""` تعني «لم يُولَّد بعد» (حالة `idle`). أي اختبار غير `idle`/`generating`
  ببصمة لا تطابق صوره الحالية يُبلَّغ عنه.

تنفَّذ الدالة في `src/content/model.ts#computeSourceFingerprint` وتُختبر في
`tests/content-model.test.ts`.

## 6. قواعد الصور (WebP فقط)

- `public/media/lessons/<id>/` و`…/thumbs/` — **`.webp` حصرًا**؛ أي امتداد آخر
  يسقط التحقق (`IMAGE_NOT_WEBP` على مستوى البايتات، لا الاسم فقط).
- لا تُلتزم أي صور مرجعية خارج النموذج: الصور الحقيقية يضيفها المالك عبر سكربت
  الاستيراد المحلي (sharp) الذي يدير: تصحيح الدوران (EXIF orientation) ← حذف EXIF
  وGPS ← تصغير (2200px للويب، 480px للمصغّرة) ← ترميز WebP ← حساب sha256 ←
  تحديث ملف الدرس. **منفَّذ في PR 5:** `npm run media:import`
  (`src/media/process.ts`) — ولا يُنسخ الأصل إلى المستودع.
- الصور المرفوعة من لوحة Sveltia تُحوَّل إلى WebP في المتصفح (بلا EXIF/GPS)، لكن
  اللوحة لا تستطيع حساب `sha256`/`width`/`height`/`thumb`؛ يكملها
  `npm run media:sync` (`src/media/sync-helpers.ts`). انظر `docs/ADMIN.md`.
- حذف EXIF بنيوي: مخرجات canvas/sharp بتنسيق WebP لا تحمل EXIF.
- الأصول الأصلية (JPEG/PNG/HEIC قبل التحويل) **محلية على جهاز المالك فقط**،
  غير ملتزمة في أي مستودع.

## 7. من SQLite إلى JSON — خريطة الترحيل

| SQLite (الحالي) | JSON (الجديد) |
|---|---|
| `units` (جدول) | `content/units/<id>.json` |
| `lessons` (جدول) | `content/lessons/<id>.json` |
| `lesson_images` (جدول، FK `lesson_id`) | مصفوفة `images` داخل ملف الدرس نفسه |
| `quizzes` + `quiz_versions` + `quiz_questions` + `generation_jobs` | `content/quizzes/{lesson,unit}-<id>.json` مع `versions[].questions[]`؛ `generation_jobs` ← سجلات Actions (للمراحل القادمة) |
| `is_last_in_unit` INTEGER 0/1 + فهرس فريد جزئي | `isLastInUnit` boolean + فحص `LAST_IN_UNIT_DUPLICATE` |
| `uq_lessons_last_per_unit` | نفس الدلالة عبر التحقق |
| `uq_quiz_lesson` / `uq_quiz_unit` | اسم الملف نفسه هو القيد |
| `schema_migrations` + `0001_init.sql` | لا ترحيل — بنية الملفات هي المخطط (schemas في الكود) |
| `position` على الدروس والصور | كما هي — ترتيب 1-based |
| `storage_key/web_key/thumb_key` (عشوائية) | `file`/`thumb` بأسماء حتمية يقررها الخط المعالج |
| `sha256`, `width`, `height`, `bytes` | كما هي |
| حالات الاختبار `idle…failed` وأعلام `confidence/needsReview` | كما هي بأنواع منطقية |

الانتقال من `data/math7.db` إلى JSON سيكون سكربتًا لمرة واحدة **إن وُجدت بيانات**
(جواب المالك: ابدأ فارغًا) — المحتوى الحقيقي يبدأ عبر لوحة الإدارة.

## 8. كيف يقرأ المحتوى المنشور من الموقع

بعد PR 4: صفحات Next الثابتة (`output: "export"`) تقرأ هذه الشجرة وقت البناء فقط —
لا طلبات وقت تشغيل، لا قاعدة بيانات، لا مفاتيح. كلفة الإضافة الوحيدة: البطء الطبيعي
لإعادة البناء الكامل عند كل نشر (وهو المقبول مع CI).

الموقع العام لا يرى إلا ما في المستودع العام، والمستودع العام يستقبل لقطة «المنشور
فقط» من المستودع الخاص عبر سير عمل النشر اليدوي (Phase 5) — راجع
`docs/ARCHITECTURE.md` (سيُضاف في PR 4) و`content/README.md`.

## 9. الفحص الآلي — `npm run content:validate`

```bash
npm run content:validate                 # التحقق الكامل (محتوى + وسائط)
npm run content:validate -- --strict     # التحذيرات تُحسب كالفيشلات
npm run content:validate -- --content X --media Y   # شجرات بديلة (كالـ example)
npm run content:stats                    # ملخص عددي سريع
```

الفحص يعمل في CI على كل PR وكل push إلى `main` (`.github/workflows/ci.yml`).
رموز الخطأ مستقرة وتُستخدم في الاختبارات:

**أخطاء (تُفشل التحقق):**
`INVALID_JSON` · `MISSING_FIELD` · `INVALID_TYPE` · `INVALID_NUMBER` · `STRING_TOO_LONG` ·
`UNKNOWN_FIELD` · `FILE_ID_MISMATCH` · `INVALID_ISO_DATE` · `ACCENT_UNKNOWN` ·
`STATUS_INVALID` · `DUPLICATE_UNIT_POSITION` · `DUPLICATE_LESSON_POSITION` ·
`LAST_IN_UNIT_DUPLICATE` · `UNIT_NOT_FOUND` · `PUBLISHED_NEEDS_IMAGES` ·
`PUBLISHED_NEEDS_PUBLISHED_AT` · `IMAGE_FILE_INVALID` · `IMAGE_THUMB_MISMATCH` ·
`IMAGE_SHA256_INVALID` · `IMAGE_POSITION_DUPLICATE` · `IMAGE_NOT_FOUND` ·
`IMAGE_THUMB_NOT_FOUND` · `IMAGE_NOT_WEBP` · `IMAGE_HASH_MISMATCH` ·
`QUIZ_FILENAME_INVALID` · `FILENAME_NOT_CANONICAL` · `DUPLICATE_ID` · `QUIZ_DUPLICATE_TARGET` ·
`QUIZ_SCOPE_INVALID` · `QUIZ_SCOPE_MISMATCH` ·
`QUIZ_TARGET_INVALID` · `QUIZ_TARGET_NOT_FOUND` · `QUIZ_FINGERPRINT_INVALID` ·
`QUIZ_ACTIVE_VERSION_INVALID` · `QUIZ_VERSION_DUPLICATE` ·
`QUIZ_QUESTION_POSITION_DUPLICATE` · `GRADING_MODE_INVALID` ·
`SOURCE_IMAGE_NOT_FOUND`

**تحذيرات (لا تُفشل إلا مع `--strict`):**
`IMAGE_ORPHAN` (ملف وسائط لا يشير إليه درس) · `MEDIA_ROOT_MISSING` (جذر الوسائط
غائب — يحدث مع شجرة فارغة) · `QUIZ_SOURCE_STALE` (الاختبار متقادم نسبةً للصور)

## 10. المثال المرجعي (وليس منهاجًا)

تحت `tests/content/example/` توجد شجرة متكاملة موسومة صراحةً بأنها **مثال للتمثيل**:
وحدتان (واحدة فيها درسان — واحد منشور بصورتين حقيقيتين بحجم ~600 بايت، وثانٍ مسودة
موسوم بأنه «آخر درس في الوحدة»)، واختبار درس بنسخته المعتمدة وسؤالين (رقمي قابل للتصحيح
الآلي ومقالي بتقييم ذاتي). تُشغَّل كل قواعد التحقق عليها في `tests/content-model.test.ts`
(٣٥ اختبارًا تغطي النجاح والفشل لكل قاعدة). هذه الشجرة الوحيدة التي يُلتزم فيها محتوى
قبل لوحة الإدارة — وكل عناوينها مبدوءة بـ«مثال مرجعي».

للتحقق محليًا من المثال:

```bash
npm run content:validate -- --content tests/content/example/content --media tests/content/example/media
```

## 11. ما يفعله هذا النموذج ولا يفعله

- ✅ يفرض السلامة البنيوية والمرجعية (الأنواع، العلاقات، الفريدة، WebP، sha256).
- ✅ يمنع نشر محتوى مكسور أو مسودات «تتسلل» إلى اللقطة المنشورة (عبر الفلتر في Phase 5).
- ✅ بوابة CI لكل تعديل — لا يمكن كسر المحتوى دون كسر الفحص.
- ❌ لا يتحقق من صحة **علمية** للمحتوى (تلك مراجعة المعلم/المالك).
- ❌ لا يفرض حقوق النشر — صور الكتاب المدرسي مسؤولية المالك.
- ❌ لا يعالج الصور — ذلك دور `npm run media:import` و`npm run media:sync` (PR 5).
