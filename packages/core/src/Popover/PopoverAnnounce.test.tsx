// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file PopoverAnnounce.test.tsx
 * @input usePopover opened from code and from its trigger, and the shared live
 *   regions
 * @output Tests that a dialog popover opened from code announces its name
 * @position Colocated with usePopover.tsx
 */

import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it} from 'vitest';
import React, {useEffect} from 'react';
import {usePopover} from './usePopover';
import {__resetLiveRegionsForTest} from '../hooks/useAnnounce';

afterEach(() => {
  __resetLiveRegionsForTest();
});

function politeText(): string {
  return (
    document.querySelector('[data-astryx-live-region="polite"]')?.textContent ??
    ''
  );
}

function CodeOpened({
  role,
  hasAutoFocus = false,
}: {
  role?: 'dialog' | 'none';
  hasAutoFocus?: boolean;
}) {
  const popover = usePopover({
    dialogLabel: 'Tip: filters live here',
    role,
    hasAutoFocus,
    hasLightDismiss: false,
  });
  const {show} = popover;
  useEffect(() => {
    show();
  }, [show]);
  return (
    <>
      <button type="button" ref={popover.triggerRef}>
        Filters
      </button>
      {popover.render(<button type="button">Got it</button>)}
    </>
  );
}

function TriggerOpened() {
  const popover = usePopover({
    dialogLabel: 'Tip: filters live here',
    hasAutoFocus: false,
    hasLightDismiss: false,
  });
  return (
    <>
      <button
        type="button"
        ref={popover.triggerRef}
        {...popover.triggerProps}
        onClick={() => popover.toggle()}>
        Filters
      </button>
      {popover.render(<button type="button">Got it</button>)}
    </>
  );
}

describe('usePopover announcement for a popover opened from code (AR4)', () => {
  it('announces the name of a dialog popover opened from code', async () => {
    render(<CodeOpened />);
    await waitFor(() => {
      expect(politeText()).toContain('Tip: filters live here');
    });
  });

  it('does not announce a popover that takes focus as it opens', async () => {
    render(<CodeOpened hasAutoFocus />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', {name: 'Got it', hidden: true}),
      ).toHaveFocus();
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(politeText()).not.toContain('Tip: filters live here');
  });

  it('does not announce a popover opened by a press on its trigger', async () => {
    render(<TriggerOpened />);
    const trigger = screen.getByRole('button', {name: 'Filters'});
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(politeText()).not.toContain('Tip: filters live here');
  });

  it('does not announce a role-neutral popup', async () => {
    render(<CodeOpened role="none" />);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(politeText()).not.toContain('Tip: filters live here');
  });
});
