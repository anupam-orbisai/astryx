---
'@astryxdesign/core': patch
---

[fix] Popover and `usePopover` `isModal` now decides whether the popover holds focus. `isModal` (the default) is unchanged: Tab and Shift+Tab cycle inside the open popover, and a dialog popover carries `aria-modal`. **Behavior change** for `isModal={false}`: before, it removed only `aria-modal` and still kept Tab inside the popover, and Escape closed it wherever focus was. Now it holds nothing: Tab moves out in the page's order, after the trigger where the browser supports popover invokers (WCAG 2.2 SC 2.4.3, Focus Order), and Escape closes it only while focus is inside it, or on or inside its anchor or trigger, so Escape reaches the control the person is using (SC 2.1.1, Keyboard). On a compact touch screen, a non-modal popover presents a sheet with no scrim: before, every sheet was modal and closed on a tap outside; now a swipe down closes it, a tap on the page does not, and Escape follows the same rule. A non-modal popover also stays open when another popover opens from the keyboard or from code; a press outside still closes it. Use `isModal={false}` for a coachmark or a tour step that lets the person reach the control it describes; leave the default where Tab must stay inside.

@nynexman4464
