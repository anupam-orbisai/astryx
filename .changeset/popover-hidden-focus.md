---
'@astryxdesign/core': patch
---

[feat] A `usePopover` surface that hides while its anchor is out of view (`anchorOutOfViewBehavior: 'hideWhileOutOfView'`) moves focus inside it out as it hides: to the anchor when it takes focus, else to the trigger, else along the focus-return chain. Focus is not moved back when the surface shows again.

@nynexman4464
