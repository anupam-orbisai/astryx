// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file The checks a render runs on the file it just wrote, so the person
 * or agent who shares it need not run them by hand: what the file asks the
 * network for, and whether its embedded source gives back every carried file
 * exactly. A check reports; it never stops the write.
 * @input the bytes of the written file, the page module, the carried files
 * @output {outside, roundTrip}
 * @position read by renderToFile in api/render/_adapter.mjs after it writes
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {readSourceBlock, renderedHeadOf, renderedMarkupOf} from './source-block.mjs';
import {assetRef, embeddedLoads, rewriteRefs} from './render-page.mjs';

/**
 * Everything the file leaves for the browser to load when it opens, read by
 * the readers the render uses for the page: every reference embeddedLoads
 * finds in the file's stylesheet and markup (link, iframe, object, embed and
 * SVG image elements, style elements, image-set()), relative ones included,
 * and the remote src, poster, srcset and style-attribute url() references
 * rewriteRefs reads (the render carries the local ones). A link a reader
 * clicks, `<a href>`, loads nothing. The page's own script is not read: what
 * it fetches is the page's behavior, not the file's.
 * @param {string} html
 * @param {string} dir the folder the file sits in
 * @returns {string[]} each reference once, in file order
 */
export function outsideRequests(html, dir) {
  /** @type {Set<string>} */
  const found = new Set();
  /** @param {string} value */
  const remote = value => {
    const ref = assetRef(value, {dir, root: dir});
    if (ref?.kind === 'remote') found.add(ref.ref);
    return null;
  };
  // What the render leaves for the browser to load, remote or a file beside
  // it, keeps the file from standing alone.
  const {style} = renderedHeadOf(html);
  const markup = renderedMarkupOf(html) ?? '';
  for (const {ref} of [...embeddedLoads(style ?? ''), ...embeddedLoads(markup)]) found.add(ref);
  rewriteRefs(markup, 'html', remote);
  return [...found];
}

/**
 * Whether the file's embedded source gives back every file the render
 * carried, byte for byte, compared in memory with the files on disk.
 * @param {string} html the written file
 * @param {string} input the page module, absolute
 * @param {string[]} files the carried files, relative to the folder that
 *   holds them all, the page first
 * @returns {{exact: boolean, files: number, differs: string[]}} `differs`:
 *   the carried paths whose embedded copy differs from the file on disk, or
 *   that are missing on either side
 */
export function roundTrip(html, input, files) {
  const block = readSourceBlock(html);
  if (!block.found || !('source' in block) || !block.source) return {exact: false, files: 0, differs: [...files]};
  /** @type {Map<string, string>} */
  const embedded = new Map(block.source.files.map((/** @type {{path: string, base64: string}} */ f) => [f.path, f.base64]));
  const root = carryRoot(input, files[0] ?? path.basename(input));
  /** @type {string[]} */
  const differs = [];
  for (const rel of new Set([...files, ...embedded.keys()])) {
    const copy = embedded.get(rel);
    let same = false;
    if (copy !== undefined && files.includes(rel)) {
      try {
        same = Buffer.from(copy, 'base64').equals(fs.readFileSync(path.join(root, rel)));
      } catch {
        same = false;
      }
    }
    if (!same) differs.push(rel);
  }
  return {exact: differs.length === 0, files: embedded.size, differs};
}

/**
 * The folder the carried paths are relative to: the page's path less its
 * carried path.
 * @param {string} input absolute
 * @param {string} page the page's carried path
 */
function carryRoot(input, page) {
  let root = path.dirname(input);
  for (let i = page.split('/').length - 1; i > 0; i -= 1) root = path.dirname(root);
  return root;
}
