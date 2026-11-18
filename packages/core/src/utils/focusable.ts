// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file focusable.ts
 * @input Elements in a document
 * @output isVisiblyFocusable and getFocusableElements: whether an element can
 *   take focus as the page shows it, and a container's focusable elements
 * @position Shared by the focus trap and focus return, so both judge
 *   reachability the same way
 */

import {FOCUSABLE_SELECTOR} from '../hooks/focusableSelector';
import {isDialogShown, isDisplayedWhileClosed} from './nodeType';

/**
 * Whether an element is currently perceivable/focusable — excludes ones hidden
 * via `display:none`/`visibility:hidden` or inside an `inert`/`hidden` subtree,
 * which the browser skips for Tab, and ones inside an `aria-hidden="true"`
 * subtree, which sighted-keyboard users could Tab to while AT skips them
 * (WCAG 4.1.2 — focusable content must be exposed to assistive tech).
 */
export function isVisiblyFocusable(el: HTMLElement): boolean {
  if (el.hasAttribute('inert') || el.closest('[inert]')) {
    return false;
  }
  if (el.hidden || el.closest('[hidden]')) {
    return false;
  }
  // A closed <dialog> that the page does not display renders nothing, so
  // nothing inside it can take focus.
  for (
    let dialog = el.closest('dialog');
    dialog != null;
    dialog = dialog.parentElement?.closest('dialog') ?? null
  ) {
    if (!isDialogShown(dialog) && !isDisplayedWhileClosed(dialog)) {
      return false;
    }
  }
  // closest() matches the element itself as well as any ancestor.
  if (el.closest('[aria-hidden="true"]')) {
    return false;
  }
  // offsetParent is null for display:none (and fixed elements); pair with a
  // visibility check via getComputedStyle when available.
  if (typeof window !== 'undefined' && window.getComputedStyle) {
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') {
      return false;
    }
  }
  return true;
}

/**
 * Get all focusable elements within a container.
 *
 * Exported for menus that place their own Tab stops inside a trapped layer
 * (DropdownMenu's header and footer), so they judge reachability exactly as
 * the trap does. Not re-exported from the package's `hooks` entry.
 */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(isVisiblyFocusable);
}
