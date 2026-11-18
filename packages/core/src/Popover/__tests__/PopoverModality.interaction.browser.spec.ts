// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file PopoverModality.interaction.browser.spec.ts
 * @input The built Non Modal and Non Modal Sheet Popover stories, real
 *   keyboard and touch input and the interaction harness
 * @output Proofs that a non-modal Popover follows the page's Tab order after
 *   its trigger, takes Escape only while focus is inside it or on its
 *   trigger, and that its sheet takes focus on open, scopes Escape the same
 *   way and hides when it closes
 * @position Browser proofs for Popover/usePopover.tsx's `isModal={false}`;
 *   jsdom has no popover invoker order and no close watcher
 */

import {expect, test, type Page} from '@astryxdesign/a11y-spec/playwright';
import {openStory, withStorybook} from '@astryxdesign/interaction-harness';

const storybook = withStorybook(test);

function controls(page: Page) {
  return {
    trigger: page.getByRole('button', {name: 'Show tip'}),
    gotIt: page.getByRole('button', {name: 'Got it'}),
    learnMore: page.getByRole('button', {name: 'Learn more'}),
    after: page.getByRole('button', {name: 'After'}),
    before: page.getByRole('button', {name: 'Before'}),
  };
}

test('Tab moves from the trigger into a non-modal popover and on to the control after the trigger', async ({
  page,
}) => {
  await openStory(page, storybook(), 'core-popover--non-modal');
  const {trigger, gotIt, learnMore, after} = controls(page);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(gotIt).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(learnMore).toBeFocused();
  // The fallback close control ends the popover's own Tab stops.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', {name: 'Close popover'})).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(after).toBeFocused();
  // Leaving focus does not close it.
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(learnMore).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(trigger).toBeFocused();
});

test('Escape passes a non-modal popover while focus is elsewhere, and closes it from its trigger', async ({
  page,
}) => {
  await openStory(page, storybook(), 'core-popover--non-modal');
  const {trigger, after} = controls(page);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  await after.focus();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  await trigger.focus();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('a non-modal sheet takes focus, scopes Escape and hides as it closes', async ({
  page,
}) => {
  await openStory(page, storybook(), 'core-popover--non-modal-sheet');
  const {trigger, gotIt, after} = controls(page);
  await trigger.focus();
  await page.keyboard.press('Enter');
  const sheet = page.locator('dialog[aria-label="Tip"]');
  await expect(sheet).toBeVisible();
  await expect(gotIt).toBeFocused();
  // No scrim: the page stays usable.
  await after.focus();
  await expect(after).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeVisible();

  await trigger.focus();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  // A bottom-sheet presentation keeps its closed sheet, so content state
  // survives a reopen.
  await expect(sheet).toBeHidden();
});
