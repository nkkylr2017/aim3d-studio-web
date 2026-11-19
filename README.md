# AIM 3D Studio Web

نسخة ويب من إضافة AIM 3D Studio: صورة قطعة أثاث ← تعرّف على النوع والتفاصيل ← نفس مجسم الإضافة (نفس الأجزاء، نفس
فيزياء القماش) ← تنزيل GLB أو DAE واستيراده في سكتشب. كل شيء يعمل في المتصفح على جهازك، والصورة لا تُرفع لأي مكان.

## التشغيل

انقر مرتين على `start.bat`، فتفتح الصفحة على `http://127.0.0.1:8642`. (لا تفتح `index.html` مباشرة: المتصفح يمنع
تشغيل الملفات من القرص بهذه الطريقة.) يحتاج Python مثبتاً (موجود على هذا الجهاز).

أول صورة تنزّل نموذج التعرّف (MobileCLIP من Hugging Face، مرة واحدة) ثم يعمل بدون إنترنت.

## في سكتشب

ملف ← استيراد ← اختر الملف.
- **GLB** (موصى به، سكتشب 2024): كل جزء مجموعة باسمه (Base, Mattress, Pillow 1…)، بالمقاس الصحيح بالسنتيمتر.
- **DAE** للنسخ الأقدم: المقاس صحيح والأجزاء منفصلة، لكن مستورد DAE في سكتشب يحذف الأسماء (حتى من ملفات سكتشب نفسها).

## ما الذي تغيّر عن الإضافة

- محرك البناء (`js/kit.js`, `js/furniture.js`) منقول سطراً بسطر من `src/aim3d_studio/smart_kit.rb` و`smart_furniture.rb`
  (نسخة 2.12.3)، ومطابق لها نقطةً بنقطة (انظر الاختبارات). الفيزياء `js/cloth_sim.js` منسوخة كما هي.
- غير موجود في نسخة الويب: المحركات السحابية (تحتاج مفاتيح API في المتصفح)، البناء خطوة بخطوة، "صور أخرى".
- الإضافة نفسها لم تتغيّر.

## Tests (developer)

```
node test/rng.test.mjs                                   # Ruby-exact random numbers
node test/parity.mjs prepare                             # cases + physics grids -> test/out
tests/launch.ps1 ; tests/run.ps1 -File ..\web\test\parity_ruby.rb -TimeoutSeconds 3000 ; tests/stop.ps1
node test/parity.mjs compare                             # every part identical to the extension's Ruby build
node --import ./test/three-hook.mjs test/export_files.mjs  # GLB/DAE files -> test/out/export
tests/run.ps1 -File ..\web\test\import_check.rb          # import them into the test SketchUp
```

`parity_ruby.rb` replaces the kit's mesh buffer in the test instance, so stop that instance afterwards.
**Any change to smart_kit.rb / smart_furniture.rb must be made in kit.js / furniture.js too; the parity test fails
until both agree.** Run it before every release of either.
