// Copyright (c) Meta Platforms, Inc. and affiliates.

'use client';

/**
 * @file bottomSheetEscape.ts
 * @input React context
 * @output BottomSheetEscapeContext: whether Escape (and the platform's close
 *   request) may dismiss the standalone sheet below it;
 *   BottomSheetEscapeScopeContext: when that sheet takes them
 * @position Internal to Core, not exported from the package: Popover's sheet
 *   presentation passes `hasEscapeDismiss` through it, so its sheet can
 *   light-dismiss (scrim tap, swipe down) while Escape stays off. A
 *   standalone BottomSheet reads the default (true), so its `purpose` rule
 *   is unchanged.
 */

import {createSharedContext} from '../utils/sharedContext';

/** Whether Escape may dismiss the sheet; `purpose="required"` still blocks it. */
export const BottomSheetEscapeContext = createSharedContext(
  'BottomSheetEscapeContext',
  1,
  true,
);
BottomSheetEscapeContext.displayName = 'BottomSheetEscapeContext';

/**
 * Whether the sheet below takes Escape and the platform's close request now.
 * A non-modal Popover sheet takes them only while focus is in its scope; null
 * (the default) means always.
 */
export const BottomSheetEscapeScopeContext = createSharedContext<
  (() => boolean) | null
>('BottomSheetEscapeScopeContext', 1, null);
BottomSheetEscapeScopeContext.displayName = 'BottomSheetEscapeScopeContext';
