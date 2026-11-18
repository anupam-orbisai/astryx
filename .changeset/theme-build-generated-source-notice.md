---
'@astryxdesign/cli': patch
---

[fix] `astryx theme build` gives a theme source marked `@generated` one notice naming its generator, instead of a warning per setting that does not show as written: its file is not where the fix goes. `settingIssues` still lists each, so a generated test fixture that styles every target no longer floods every build.

@josephfarina
