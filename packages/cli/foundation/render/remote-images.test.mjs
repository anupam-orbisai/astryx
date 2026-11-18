// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file Tests for remote-images.mjs and for how a render uses it: an image a
 * page names by an https address is fetched once and carried, and every way
 * a fetch can fail leaves the address and says why.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {JSDOM} from 'jsdom';
import {render} from '../../api/render/render.mjs';
import {imageRequest, imageTypeOf, remoteImages} from './remote-images.mjs';
import {renderPage} from './render-page.mjs';
import {readSourceBlock, renderedMarkupOf} from './source-block.mjs';
import {ROOT_ID} from './client-bundle.mjs';
import {
  makeLinkedFixture,
  removeLinkedFixture,
} from '../../test-utils/linked-fixture.mjs';

/** A fetch answer. @param {any} body @param {ResponseInit} [init] */
const respond = (body, init) => new globalThis.Response(body, init);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A fetch that answers each address from `answers`: a Response, or a
 * function of the request's signal.
 * @param {Record<string, any>} answers
 */
function fetchFrom(answers) {
  /** @type {{url: string, init: RequestInit}[]} */
  const asked = [];
  /** @type {typeof globalThis.fetch} */
  const fetch = async (url, init = {}) => {
    asked.push({url: String(url), init});
    const answer = answers[String(url)];
    if (answer === undefined) throw new TypeError('fetch failed');
    return typeof answer === 'function' ? answer(init.signal) : answer;
  };
  return {fetch, asked};
}

/** An answer that never comes, until the request is stopped. @param {any} signal */
const never = signal =>
  new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {once: true});
  });

const png = () => respond(PNG, {headers: {'content-type': 'image/png'}});

describe('remoteImages', () => {
  it('fetches an https image once, with no credentials, as a data: URI', async () => {
    const {fetch, asked} = fetchFrom({'https://example.com/a.png?w=2': png()});
    const remote = remoteImages({fetch});
    await remote.get([
      'https://example.com/a.png?w=2',
      'https://example.com/a.png?w=2',
    ]);
    await remote.get(['https://example.com/a.png?w=2']);
    remote.done();
    expect(asked).toHaveLength(1);
    expect(asked[0].init.credentials).toBe('omit');
    expect(asked[0].init.referrerPolicy).toBe('no-referrer');
    expect(remote.results.get('https://example.com/a.png?w=2')).toEqual({
      uri: `data:image/png;base64,${PNG.toString('base64')}`,
    });
    expect(remote.summary()).toEqual({
      fetched: ['https://example.com/a.png?w=2'],
      failed: [],
    });
  });

  it('says why an image was not fetched: offline, too slow, too large, not an image, not https', async () => {
    const big = Buffer.alloc(300, 1);
    const {fetch, asked} = fetchFrom({
      'https://example.com/slow.png': never,
      'https://example.com/page.png': respond('<html></html>', {
        headers: {'content-type': 'text/html'},
      }),
      'https://example.com/lies.png': respond('not a picture', {
        headers: {'content-type': 'image/png'},
      }),
      'https://example.com/said-big.png': respond(PNG, {
        headers: {'content-type': 'image/png', 'content-length': '999999999'},
      }),
      'https://example.com/is-big.png': respond(Buffer.concat([PNG, big]), {
        headers: {'content-type': 'image/png'},
      }),
      'https://example.com/gone.png': respond('', {status: 404}),
      'https://example.com/dropped.png': respond(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(PNG.subarray(0, 8)));
            controller.error(new Error('connection reset'));
          },
        }),
        {headers: {'content-type': 'image/png'}},
      ),
    });
    const remote = remoteImages({fetch, timeoutMs: 50, maxBytes: 200});
    await remote.get([
      'https://example.com/offline.png',
      'https://example.com/slow.png',
      'https://example.com/page.png',
      'https://example.com/lies.png',
      'https://example.com/said-big.png',
      'https://example.com/is-big.png',
      'https://example.com/gone.png',
      'https://example.com/dropped.png',
      'http://example.com/plain.png',
      'https://me:secret@example.com/private.png',
    ]);
    remote.done();
    const reasons = Object.fromEntries(
      remote.summary().failed.map(({url, reason}) => [url, reason]),
    );
    expect(remote.summary().fetched).toEqual([]);
    expect(reasons).toEqual({
      'https://example.com/offline.png': 'the network could not reach it',
      'https://example.com/slow.png': 'no answer within 0.05 s',
      'https://example.com/page.png': 'not an image',
      'https://example.com/lies.png': 'not an image',
      'https://example.com/said-big.png': `larger than ${200 / 1048576} MB, the most a rendered page carries of one file`,
      'https://example.com/is-big.png': `larger than ${200 / 1048576} MB, the most a rendered page carries of one file`,
      'https://example.com/gone.png': 'the server answered 404',
      'https://example.com/dropped.png':
        'the connection closed before the image arrived',
      'http://example.com/plain.png': 'not an https address',
      'https://me:secret@example.com/private.png':
        'the address holds a user name or password, which a render never sends',
    });
    // An address that is not https, or that holds credentials, is never asked.
    expect(asked.map(a => a.url)).not.toContain('http://example.com/plain.png');
    expect(asked.some(a => a.url.includes('secret'))).toBe(false);
  });

  it('stops every image still waiting when the render runs out of time', async () => {
    const {fetch} = fetchFrom({
      'https://example.com/1.png': never,
      'https://example.com/2.png': never,
    });
    const remote = remoteImages({fetch, timeoutMs: 10_000, budgetMs: 50});
    const started = Date.now();
    await remote.get([
      'https://example.com/1.png',
      'https://example.com/2.png',
    ]);
    remote.done();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(remote.summary().failed.map(f => f.reason)).toEqual([
      'the render ran out of the time it gives remote images',
      'the render ran out of the time it gives remote images',
    ]);
  });

  it('asks for no more images once the network answers none of the first ones', async () => {
    const urls = Array.from(
      {length: 10},
      (_, i) => `https://example.com/${i}.png`,
    );
    const {fetch, asked} = fetchFrom(
      Object.fromEntries(urls.map(url => [url, never])),
    );
    const remote = remoteImages({fetch, answerMs: 50, timeoutMs: 10_000});
    const started = Date.now();
    await remote.get(urls);
    remote.done();
    expect(Date.now() - started).toBeLessThan(2000);
    // The first six went out at once and got no answer; the rest were never asked.
    expect(asked).toHaveLength(6);
    const reasons = remote.summary().failed.map(f => f.reason);
    expect(reasons.slice(0, 6)).toEqual(
      Array(6).fill('no answer within 0.05 s'),
    );
    expect(reasons.slice(6)).toEqual(
      Array(4).fill(
        'not asked: the network answered none of the first images the render asked for',
      ),
    );
  });

  it('counts no error status as the network answering, as a proxy with no way out answers', async () => {
    const {fetch, asked} = fetchFrom({
      'https://pay.example/badge.png': respond('', {status: 403}),
      'https://cdn.example/a.svg': never,
      'https://cdn.example/b.svg': never,
    });
    const remote = remoteImages({fetch, answerMs: 50, timeoutMs: 10_000});
    const started = Date.now();
    await remote.get([
      'https://pay.example/badge.png',
      'https://cdn.example/a.svg',
    ]);
    await remote.get(['https://cdn.example/b.svg']);
    remote.done();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(asked.map(a => a.url)).not.toContain('https://cdn.example/b.svg');
    expect(remote.summary().failed.map(f => f.reason)).toEqual([
      'the server answered 403',
      'no answer within 0.05 s',
      'not asked: the network answered none of the first images the render asked for',
    ]);
  });

  it('keeps asking when the network answers, even if one server is slow', async () => {
    const {fetch, asked} = fetchFrom({
      'https://slow.example/a.png': never,
      'https://slow.example/b.png': never,
      'https://example.com/ok.png': png(),
      'https://example.com/late.png': png(),
    });
    const remote = remoteImages({fetch, answerMs: 50, timeoutMs: 10_000});
    await remote.get([
      'https://example.com/ok.png',
      'https://slow.example/a.png',
      'https://slow.example/b.png',
    ]);
    await remote.get(['https://example.com/late.png']);
    remote.done();
    expect(asked.map(a => a.url)).toContain('https://example.com/late.png');
    expect(remote.summary().fetched).toEqual([
      'https://example.com/ok.png',
      'https://example.com/late.png',
    ]);
  });

  it('lists the addresses in the order the page names them, whichever answers first', async () => {
    const {fetch} = fetchFrom({
      'https://example.com/slow.png': () =>
        new Promise(resolve => setTimeout(() => resolve(png()), 40)),
      'https://example.com/fast.png': png(),
    });
    const remote = remoteImages({fetch});
    await remote.get([
      'https://example.com/slow.png',
      'https://example.com/fast.png',
    ]);
    remote.done();
    expect(remote.summary().fetched).toEqual([
      'https://example.com/slow.png',
      'https://example.com/fast.png',
    ]);
  });

  it('tells an image by its bytes', () => {
    expect(imageTypeOf(PNG)).toBe('image/png');
    expect(imageTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      'image/jpeg',
    );
    expect(
      imageTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBe('image/svg+xml');
    expect(imageTypeOf(Buffer.from('wOF2'))).toBeNull();
    expect(imageTypeOf(Buffer.from('<html><body>hi</body></html>'))).toBeNull();
  });
});

describe('imageRequest', () => {
  /** @type {http.Server} */
  let server;
  let base = '';
  /** @type {http.IncomingHttpHeaders[]} */
  const seen = [];
  let holdClosed = false;
  /** @type {() => void} */
  let held = () => {};
  const heldArrived = new Promise(resolve => {
    held = () => resolve(undefined);
  });
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === '/hold') {
        req.on('close', () => {
          holdClosed = true;
        });
        held();
        return;
      }
      if (req.url === '/moved') {
        res.writeHead(302, {location: '/a.png'});
        res.end();
        return;
      }
      if (req.url === '/broken') {
        res.writeHead(302, {location: 'http://[bad'});
        res.end();
        return;
      }
      if (req.url === '/away') {
        res.writeHead(302, {location: 'https://example.com/a.png'});
        res.end();
        return;
      }
      res.writeHead(200, {'content-type': 'image/png'});
      res.end(PNG);
    });
    await new Promise(resolve =>
      server.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    const address = /** @type {import('node:net').AddressInfo} */ (
      server.address()
    );
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve(undefined)));
  });

  it('reads an image through a redirect of the same scheme, with no cookie and no open connection', async () => {
    const answer = await imageRequest(
      `${base}/moved`,
      {headers: {accept: 'image/*'}},
      /** @type {any} */ (http),
    );
    expect(answer.ok).toBe(true);
    expect(answer.url).toBe(`${base}/a.png`);
    expect(answer.headers.get('content-type')).toBe('image/png');
    const chunks = [];
    for await (const chunk of answer.body) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(PNG);
    expect(
      seen.every(
        headers =>
          headers.cookie === undefined && headers.authorization === undefined,
      ),
    ).toBe(true);
    expect(seen.at(-1)?.connection).toBe('close');
  });

  it('answers a redirect to an address that is not valid as such, and never throws', async () => {
    const answer = await imageRequest(
      `${base}/broken`,
      {},
      /** @type {any} */ (http),
    );
    expect(answer.ok).toBe(false);
    expect(answer.badLocation).toBe(true);
  });

  it('does not follow a redirect to another scheme', async () => {
    const answer = await imageRequest(
      `${base}/away`,
      {},
      /** @type {any} */ (http),
    );
    expect(answer.ok).toBe(false);
    expect(answer.url).toBe('https://example.com/a.png');
  });

  it('closes its socket at once when the render stops it', async () => {
    const stop = new AbortController();
    const asked = imageRequest(
      `${base}/hold`,
      {signal: stop.signal},
      /** @type {any} */ (http),
    );
    await heldArrived;
    stop.abort();
    await expect(asked).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(holdClosed).toBe(true);
  });
});

describe('a render with images from the web', () => {
  it('carries a fetched image in the markup and the script, and keeps the address in the source', async () => {
    const dir = makeLinkedFixture('astryx-render-remote-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          'export default function Page() {',
          '  return (',
          '    <main>',
          '      <img src="https://example.com/shoe.png" alt="Shoe" />',
          '      <img src="http://example.com/plain.png" alt="Plain" />',
          '      <div style={{backgroundImage: "url(https://example.com/shoe.png)"}}>Back</div>',
          '      <link rel="preload" href="https://example.com/font.woff2" />',
          '    </main>',
          '  );',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch, asked} = fetchFrom({'https://example.com/shoe.png': png()});
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      const markup = renderedMarkupOf(page.html) ?? '';
      const data = `data:image/png;base64,${PNG.toString('base64')}`;
      expect(markup).toContain(`src="${data}"`);
      expect(markup).toContain('src="http://example.com/plain.png"');
      expect(asked.map(a => a.url)).toEqual(['https://example.com/shoe.png']);
      // The script draws the page with the same data.
      const script = page.html.slice(page.html.lastIndexOf('<script>'));
      expect(script).not.toContain('"https://example.com/shoe.png"');
      expect(page.remoteImages).toEqual({
        fetched: ['https://example.com/shoe.png'],
        failed: [
          {url: 'http://example.com/plain.png', reason: 'not an https address'},
        ],
      });
      const warned = page.warnings
        .filter(w => w.code === 'remote-asset')
        .map(w => w.message);
      expect(
        warned.some(m => m.startsWith('http://example.com/plain.png')),
      ).toBe(true);
      expect(
        warned.some(m => m.startsWith('https://example.com/shoe.png')),
      ).toBe(false);
      // The source keeps the address the page wrote, so the way back is the page.
      const source = readSourceBlock(page.html);
      const carried = Buffer.from(
        /** @type {any} */ (source).source.files[0].base64,
        'base64',
      ).toString('utf8');
      expect(carried).toContain('src="https://example.com/shoe.png"');
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('fetches an address by the image word in its name, never by a word that only holds one', async () => {
    const dir = makeLinkedFixture('astryx-render-names-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          'const links = {',
          "  logoutUrl: 'https://example.com/logout',",
          "  apiConfigUrl: 'https://example.com/api/config',",
          "  discoverUrl: 'https://example.com/discover',",
          "  recoveryUrl: 'https://example.com/recovery',",
          '};',
          "const team = {iconUrl: 'https://example.com/team-icon'};",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return (',
          '    <main>',
          '      <a href={links.logoutUrl}>Out</a>',
          '      <button onClick={() => setOpen(true)}>Team</button>',
          '      {open && <img src={team.iconUrl} alt="Team" />}',
          '    </main>',
          '  );',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch, asked} = fetchFrom({
        'https://example.com/team-icon': png(),
      });
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(asked.map(a => a.url)).toEqual(['https://example.com/team-icon']);
      expect(page.remoteImages?.fetched).toEqual([
        'https://example.com/team-icon',
      ]);
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('keeps a fetched background image once the script draws the page', async () => {
    const dir = makeLinkedFixture('astryx-render-style-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        'export default function Page() { return <div style={{backgroundImage: "url(https://example.com/bg.png)"}}>Hero</div>; }\n',
      );
      const {fetch} = fetchFrom({'https://example.com/bg.png': png()});
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      const data = `data:image/png;base64,${PNG.toString('base64')}`;
      expect(renderedMarkupOf(page.html)).toContain(data);
      const script = page.html.slice(page.html.lastIndexOf('<script>'));
      expect(script).not.toContain('https://example.com/bg.png');
      expect(script).toContain(`url(${data}#)`);
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('requests an API address an image-named property holds, and keeps it with no warning when the answer is not an image', async () => {
    const dir = makeLinkedFixture('astryx-render-api-', ['react', 'react-dom']);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          "const config = {imageUploadUrl: 'https://api.example.com/v1/upload'};",
          'export default function Page() {',
          '  const [sent, setSent] = useState(false);',
          "  return <main><button onClick={() => fetch(config.imageUploadUrl, {method: 'POST'}).then(() => setSent(true))}>Upload</button>{sent && <p>Sent</p>}</main>;",
          '}',
          '',
        ].join('\n'),
      );
      const {fetch} = fetchFrom({
        'https://api.example.com/v1/upload': respond('{"ok":true}', {
          headers: {'content-type': 'application/json'},
        }),
      });
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(page.warnings.filter(w => w.code === 'remote-asset')).toEqual([]);
      expect(page.remoteImages?.failed).toEqual([
        {url: 'https://api.example.com/v1/upload', reason: 'not an image'},
      ]);
      expect(page.html.slice(page.html.lastIndexOf('<script>'))).toContain(
        '"https://api.example.com/v1/upload"',
      );
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it("never asks for a link's address, even when it names an image file", async () => {
    const dir = makeLinkedFixture('astryx-render-link-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return (',
          '    <main>',
          '      <a href="https://example.com/first.png">First</a>',
          '      <button onClick={() => setOpen(true)}>More</button>',
          '      {open && <a href="https://example.com/brochure.png">Brochure</a>}',
          '    </main>',
          '  );',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch, asked} = fetchFrom({});
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(asked).toEqual([]);
      expect(renderedMarkupOf(page.html)).toContain(
        'href="https://example.com/first.png"',
      );
      expect(page.html.slice(page.html.lastIndexOf('<script>'))).toContain(
        '"https://example.com/brochure.png"',
      );
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('warns for an image the script draws later when its server answers an error status', async () => {
    const dir = makeLinkedFixture('astryx-render-late-404-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          "const user = {avatarUrl: 'https://example.com/gone'};",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return <main><button onClick={() => setOpen(true)}>Me</button>{open && <img src={user.avatarUrl} alt="Me" />}</main>;',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch} = fetchFrom({
        'https://example.com/gone': respond('', {status: 404}),
      });
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(page.warnings).toContainEqual({
        code: 'remote-asset',
        message:
          "https://example.com/gone, which the page's code names as an image, is loaded from the network when the script draws it, which a sandboxed page cannot reach; save it beside the page and import it instead. The render could not fetch it: the server answered 404.",
      });
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('warns for an address counted by its path when its server answers with a page', async () => {
    const dir = makeLinkedFixture('astryx-render-late-page-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          "const rows = [{url: 'https://example.com/shoe.png'}];",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return <main><button onClick={() => setOpen(true)}>Show</button>{open && rows.map(r => <img key={r.url} src={r.url} alt="" />)}</main>;',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch} = fetchFrom({
        'https://example.com/shoe.png': respond(
          '<!doctype html><title>Sign in</title>',
          {headers: {'content-type': 'text/html'}},
        ),
      });
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(page.warnings).toContainEqual({
        code: 'remote-asset',
        message:
          "https://example.com/shoe.png, which the page's code names as an image, is loaded from the network when the script draws it, which a sandboxed page cannot reach; save it beside the page and import it instead. The render could not fetch it: not an image.",
      });
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it("never asks for an address a variable holds when the page uses it as a link's address", async () => {
    const dir = makeLinkedFixture('astryx-render-link-var-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          "const fullSize = 'https://cdn.example.com/shoe-large.png';",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return <main><button onClick={() => setOpen(true)}>More</button>{open && <a href={fullSize}>Full size</a>}</main>;',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch, asked} = fetchFrom({});
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(asked).toEqual([]);
      expect(page.html.slice(page.html.lastIndexOf('<script>'))).toContain(
        '"https://cdn.example.com/shoe-large.png"',
      );
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('fetches no first part of an address built with +, and warns for the built address', async () => {
    const dir = makeLinkedFixture('astryx-render-plus-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          'export default function Page() {',
          '  const [size, setSize] = useState(0);',
          '  return <main><button onClick={() => setSize(640)}>Show</button>{size > 0 && <img src={\'https://cdn.example.com/hero.png?size=\' + size} alt="" />}</main>;',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch, asked} = fetchFrom({});
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(asked).toEqual([]);
      expect(page.html.slice(page.html.lastIndexOf('<script>'))).toContain(
        'https://cdn.example.com/hero.png?size=',
      );
      expect(
        page.warnings.some(
          w =>
            w.code === 'remote-asset' &&
            w.message.includes('builds an image address in code'),
        ),
      ).toBe(true);
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('carries each candidate of a srcSet the script draws later', async () => {
    const dir = makeLinkedFixture('astryx-render-srcset-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return <main><button onClick={() => setOpen(true)}>Show</button>{open && <img srcSet="https://example.com/a.png 1x, https://example.com/a@2x.png 2x" alt="" />}</main>;',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch, asked} = fetchFrom({
        'https://example.com/a.png': png(),
        'https://example.com/a@2x.png': png(),
      });
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(asked.map(a => a.url).sort()).toEqual([
        'https://example.com/a.png',
        'https://example.com/a@2x.png',
      ]);
      const data = `data:image/png;base64,${PNG.toString('base64')}`;
      const script = page.html.slice(page.html.lastIndexOf('<script>'));
      expect(script).toContain(`${data} 1x, ${data} 2x`);
      expect(script).not.toContain('https://example.com/a.png');
      expect(page.warnings.filter(w => w.code === 'remote-asset')).toEqual([]);
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('keeps an image drawn later whose address the code extends, as a data URI with an empty fragment', async () => {
    const dir = makeLinkedFixture('astryx-render-extend-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          "const hero = 'https://cdn.example.com/hero.png';",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return <main><button onClick={() => setOpen(true)}>Show</button>{open && <img src={`${hero}?w=640`} alt="" />}</main>;',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch} = fetchFrom({'https://cdn.example.com/hero.png': png()});
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      const data = `data:image/png;base64,${PNG.toString('base64')}`;
      const script = page.html.slice(page.html.lastIndexOf('<script>'));
      // `${hero}?w=640` then reads `data:…#?w=640`: the query joins the
      // fragment, which a data: URL ignores.
      expect(script).toContain(`"${data}#"`);
      expect(script).not.toContain('https://cdn.example.com/hero.png');
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('reads a srcSet address that holds commas whole, and leaves a srcSet it carried nothing from as written', async () => {
    const dir = makeLinkedFixture('astryx-render-srcset-commas-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return (',
          '    <main>',
          '      <button onClick={() => setOpen(true)}>Show</button>',
          '      {open && <img srcSet="https://img.example.com/upload/c_fill,w_400/a.png 1x, https://img.example.com/upload/c_fill,w_800/a.png 2x" alt="" />}',
          '      {open && <img srcSet="https://offline.example.com/b.png 1x, https://offline.example.com/b@2x.png 2x" alt="" />}',
          '    </main>',
          '  );',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch, asked} = fetchFrom({
        'https://img.example.com/upload/c_fill,w_400/a.png': png(),
        'https://img.example.com/upload/c_fill,w_800/a.png': png(),
      });
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(asked.map(a => a.url)).toEqual(
        expect.arrayContaining([
          'https://img.example.com/upload/c_fill,w_400/a.png',
          'https://img.example.com/upload/c_fill,w_800/a.png',
        ]),
      );
      const data = `data:image/png;base64,${PNG.toString('base64')}`;
      const script = page.html.slice(page.html.lastIndexOf('<script>'));
      expect(script).toContain(`${data} 1x, ${data} 2x`);
      expect(script).toContain(
        'https://offline.example.com/b.png 1x, https://offline.example.com/b@2x.png 2x',
      );
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('asks for no src of an element that shows no image, such as an iframe or a video', async () => {
    const dir = makeLinkedFixture('astryx-render-iframe-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        'export default function Page() { return <main><iframe src="https://example.com/embed.png" title="x" /><video src="https://example.com/clip.png" /></main>; }\n',
      );
      const {fetch, asked} = fetchFrom({});
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(asked).toEqual([]);
      expect(page.remoteImages).toBeUndefined();
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('keeps an address the code changes with the URL API as written, and warns for it', async () => {
    const dir = makeLinkedFixture('astryx-render-url-api-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          "const photo = 'https://cdn.example.com/photo.png';",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  const url = new URL(photo);',
          "  url.searchParams.set('w', '400');",
          '  return <main><button onClick={() => setOpen(true)}>Show</button>{open && <img src={url.href} alt="" />}</main>;',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch, asked} = fetchFrom({
        'https://cdn.example.com/photo.png': png(),
      });
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(asked).toEqual([]);
      expect(page.html.slice(page.html.lastIndexOf('<script>'))).toContain(
        'https://cdn.example.com/photo.png',
      );
      expect(
        page.warnings.some(
          w =>
            w.code === 'remote-asset' &&
            w.message.includes(
              "'https://cdn.example.com/photo.png' (page.jsx:2) is an image address the page changes with the URL API",
            ),
        ),
      ).toBe(true);
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('keeps an address as written that reaches the URL API through a helper or beside the first paint, and treats a property read as untraced', async () => {
    const dir = makeLinkedFixture('astryx-render-url-api-reach-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          "const items = [{name: 'A', photoUrl: 'https://cdn.example.com/a.png'}];",
          "const shown = 'https://cdn.example.com/d.png';",
          'function sized(src) {',
          '  const url = new URL(src);',
          "  url.searchParams.set('w', '400');",
          '  return url.href;',
          '}',
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  const first = new URL(items[0].photoUrl);',
          "  first.searchParams.set('w', '400');",
          '  return (',
          '    <main>',
          '      <img src={shown} alt="Shown" />',
          '      <button onClick={() => setOpen(true)}>Show</button>',
          '      {open && <img src={first.href} alt="Property" />}',
          '      {open && <img src={sized(\'https://cdn.example.com/b.png\')} alt="Helper" />}',
          '      {open && <img src={sized(shown)} alt="Both" />}',
          '    </main>',
          '  );',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch, asked} = fetchFrom({
        'https://cdn.example.com/a.png': png(),
        'https://cdn.example.com/b.png': png(),
        'https://cdn.example.com/d.png': png(),
      });
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      const data = `data:image/png;base64,${PNG.toString('base64')}`;
      const script = page.html.slice(page.html.lastIndexOf('<script>'));
      // The first paint still carries the image it shows.
      expect(asked.map(a => a.url)).toEqual(['https://cdn.example.com/d.png']);
      expect(renderedMarkupOf(page.html)).toContain(data);
      // The script keeps each address the URL API changes as written.
      for (const url of [
        'https://cdn.example.com/a.png',
        'https://cdn.example.com/b.png',
        'https://cdn.example.com/d.png',
      ]) {
        expect(script).toContain(url);
      }
      expect(script).not.toContain(`${data}#`);
      const changed = page.warnings.filter(
        w =>
          w.code === 'remote-asset' &&
          w.message.includes('changes with the URL API'),
      );
      expect(
        changed.map(w => w.message.slice(0, w.message.indexOf(')') + 1)),
      ).toEqual(
        expect.arrayContaining([
          "'https://cdn.example.com/b.png' (page.jsx:18)",
          "'https://cdn.example.com/d.png' (page.jsx:3)",
        ]),
      );
      // A property read (`items[0].photoUrl`) is not traced: one warning
      // names that call, and the result lists the address the script keeps.
      expect(
        page.warnings.filter(w => w.message.includes('cannot trace')),
      ).toHaveLength(1);
      expect(page.remoteImages?.failed.map(f => f.url)).toEqual(
        expect.arrayContaining(['https://cdn.example.com/a.png']),
      );
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('keeps every script address as written when the URL API gets an address the render cannot trace', async () => {
    const dir = makeLinkedFixture('astryx-render-url-api-untraced-', [
      'react',
      'react-dom',
    ]);
    try {
      fs.writeFileSync(
        path.join(dir, 'sized.js'),
        "export function sized(src) {\n  const url = new URL(src);\n  url.searchParams.set('w', '200');\n  return url.href;\n}\n",
      );
      const pages = {
        // A callback's parameter.
        'callback.jsx': [
          "import {useState} from 'react';",
          "const gallery = ['https://cdn.example.com/g.png'];",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  const sized = gallery.map(src => {',
          '    const url = new URL(src);',
          "    url.searchParams.set('w', '200');",
          '    return url.href;',
          '  });',
          '  return <main><button onClick={() => setOpen(true)}>Show</button>{open && <img src={sized[0]} alt="" />}</main>;',
          '}',
          '',
        ],
        // A helper another file exports.
        'imported.jsx': [
          "import {useState} from 'react';",
          "import {sized} from './sized.js';",
          "const photo = 'https://cdn.example.com/g.png';",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return <main><button onClick={() => setOpen(true)}>Show</button>{open && <img src={sized(photo)} alt="" />}</main>;',
          '}',
          '',
        ],
      };
      for (const [name, lines] of Object.entries(pages)) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, lines.join('\n'));
        const {fetch, asked} = fetchFrom({
          'https://cdn.example.com/g.png': png(),
        });
        const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
        expect(asked, name).toEqual([]);
        expect(
          page.html.slice(page.html.lastIndexOf('<script>')),
          name,
        ).toContain('https://cdn.example.com/g.png');
        expect(
          page.warnings.filter(
            w =>
              w.code === 'remote-asset' && w.message.includes('cannot trace'),
          ),
          name,
        ).toHaveLength(1);
        expect(page.remoteImages?.failed, name).toEqual([
          expect.objectContaining({
            url: 'https://cdn.example.com/g.png',
            reason: expect.stringContaining('cannot trace'),
          }),
        ]);
      }
    } finally {
      removeLinkedFixture(dir);
    }
  }, 180_000);

  it('traces an address to the URL API through a default value, and treats a loop variable as untraced', async () => {
    const dir = makeLinkedFixture('astryx-render-url-api-loop-', [
      'react',
      'react-dom',
    ]);
    try {
      const pages = {
        'loop.jsx': [
          "import {useState} from 'react';",
          "const gallery = ['https://cdn.example.com/g.png'];",
          'const sized = [];',
          'for (const src of gallery) {',
          '  const url = new URL(src);',
          "  url.searchParams.set('w', '200');",
          '  sized.push(url.href);',
          '}',
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return <main><button onClick={() => setOpen(true)}>Show</button>{open && <img src={sized[0]} alt="" />}</main>;',
          '}',
          '',
        ],
        'default.jsx': [
          "import {useState} from 'react';",
          "function sized(src = 'https://cdn.example.com/g.png') {",
          '  const url = new URL(src);',
          "  url.searchParams.set('w', '200');",
          '  return url.href;',
          '}',
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return <main><button onClick={() => setOpen(true)}>Show</button>{open && <img src={sized()} alt="" />}</main>;',
          '}',
          '',
        ],
      };
      for (const [name, lines] of Object.entries(pages)) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, lines.join('\n'));
        const {fetch, asked} = fetchFrom({
          'https://cdn.example.com/g.png': png(),
        });
        const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
        expect(asked, name).toEqual([]);
        expect(
          page.html.slice(page.html.lastIndexOf('<script>')),
          name,
        ).toContain('https://cdn.example.com/g.png');
        const messages = page.warnings
          .filter(w => w.code === 'remote-asset')
          .map(w => w.message);
        // A default value is traced; a loop variable is not.
        expect(
          messages.some(m => m.includes('changes with the URL API')),
          name,
        ).toBe(name === 'default.jsx');
        expect(
          messages.some(m => m.includes('cannot trace')),
          name,
        ).toBe(name === 'loop.jsx');
        expect(page.remoteImages?.failed, name).toEqual([
          expect.objectContaining({
            url: 'https://cdn.example.com/g.png',
            reason: expect.stringContaining('URL API'),
          }),
        ]);
      }
    } finally {
      removeLinkedFixture(dir);
    }
  }, 180_000);

  it('treats a property array and an array changed after it is made as untraced', async () => {
    const dir = makeLinkedFixture('astryx-render-url-api-arrays-', [
      'react',
      'react-dom',
    ]);
    try {
      const pages = {
        'property.jsx': [
          "import {useState} from 'react';",
          "const product = {name: 'Shoe', photos: ['https://cdn.example.com/g.png']};",
          'const sized = [];',
          'for (const src of product.photos) {',
          '  const url = new URL(src);',
          "  url.searchParams.set('w', '200');",
          '  sized.push(url.href);',
          '}',
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return <main><button onClick={() => setOpen(true)}>Show</button>{open && <img src={sized[0]} alt="" />}</main>;',
          '}',
          '',
        ],
        'changed.jsx': [
          "import {useState} from 'react';",
          'const photos = [];',
          "photos.push('https://cdn.example.com/g.png');",
          'const sized = [];',
          'for (const src of photos) {',
          '  const url = new URL(src);',
          "  url.searchParams.set('w', '200');",
          '  sized.push(url.href);',
          '}',
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return <main><button onClick={() => setOpen(true)}>Show</button>{open && <img src={sized[0]} alt="" />}</main>;',
          '}',
          '',
        ],
      };
      for (const [name, lines] of Object.entries(pages)) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, lines.join('\n'));
        const {fetch, asked} = fetchFrom({
          'https://cdn.example.com/g.png': png(),
        });
        const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
        expect(asked, name).toEqual([]);
        expect(
          page.html.slice(page.html.lastIndexOf('<script>')),
          name,
        ).toContain('https://cdn.example.com/g.png');
        const messages = page.warnings
          .filter(w => w.code === 'remote-asset')
          .map(w => w.message);
        expect(
          messages.some(m => m.includes('cannot trace')),
          name,
        ).toBe(true);
        expect(
          page.remoteImages?.failed.map(f => f.url),
          name,
        ).toEqual(['https://cdn.example.com/g.png']);
      }
    } finally {
      removeLinkedFixture(dir);
    }
  }, 180_000);

  it('lists a first-paint image the script then draws from the network as not carried, when the URL API gets an untraced address', async () => {
    const dir = makeLinkedFixture('astryx-render-url-api-first-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          "  const sized = ['https://cdn.example.com/g.png'].map(src => new URL(src).href);",
          '  return (',
          '    <main>',
          '      <img src="https://cdn.example.com/f.png" alt="First" />',
          '      <button onClick={() => setOpen(true)}>Show</button>',
          '      {open && <img src={sized[0]} alt="" />}',
          '    </main>',
          '  );',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch} = fetchFrom({
        'https://cdn.example.com/f.png': png(),
        'https://cdn.example.com/g.png': png(),
      });
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(page.remoteImages?.fetched).not.toContain(
        'https://cdn.example.com/f.png',
      );
      expect(page.remoteImages?.failed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: 'https://cdn.example.com/f.png',
            reason: expect.stringContaining('cannot trace'),
          }),
        ]),
      );
      expect(page.html.slice(page.html.lastIndexOf('<script>'))).toContain(
        'https://cdn.example.com/f.png',
      );
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('still carries a kept address in a stylesheet, counts a pushed property array as untraced, and lists each candidate of a kept srcset', async () => {
    const dir = makeLinkedFixture('astryx-render-url-api-kept-', [
      'react',
      'react-dom',
    ]);
    try {
      fs.writeFileSync(
        path.join(dir, 'page.css'),
        '.hero { background-image: url(https://cdn.example.com/a.png); }\n',
      );
      fs.writeFileSync(
        path.join(dir, 'data.json'),
        JSON.stringify({
          set: 'https://cdn.example.com/s1.png 1x, https://cdn.example.com/s2.png 2x',
        }),
      );
      const pages = {
        // A traced URL API call on an address a stylesheet also names.
        'styled.jsx': [
          "import './page.css';",
          "const hero = 'https://cdn.example.com/a.png';",
          'export default function Page() {',
          '  const url = new URL(hero);',
          "  url.searchParams.set('w', '200');",
          '  return <main className="hero"><img src={hero} alt="Hero" /><p>{url.href}</p></main>;',
          '}',
          '',
        ],
        // An element pushed onto a property's array after it is made.
        'pushed.jsx': [
          "import {useState} from 'react';",
          "const product = {photos: ['https://cdn.example.com/a.png']};",
          "product.photos.push('https://cdn.example.com/b.png');",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  const sized = [];',
          '  for (const src of product.photos) {',
          '    const url = new URL(src);',
          "    url.searchParams.set('w', '200');",
          '    sized.push(url.href);',
          '  }',
          '  return <main><button onClick={() => setOpen(true)}>Show</button>{open && sized.map(s => <img key={s} src={s} alt="" />)}</main>;',
          '}',
          '',
        ],
        // A first-paint srcset read from a JSON file, under the untraced fallback.
        'jsonset.jsx': [
          "import data from './data.json';",
          'export default function Page() {',
          "  const sized = ['https://cdn.example.com/g.png'].map(src => new URL(src).href);",
          '  return <main><img srcSet={data.set} alt="Set" /><p>{sized[0]}</p></main>;',
          '}',
          '',
        ],
      };
      const images = {
        'https://cdn.example.com/a.png': png(),
        'https://cdn.example.com/b.png': png(),
        'https://cdn.example.com/g.png': png(),
        'https://cdn.example.com/s1.png': png(),
        'https://cdn.example.com/s2.png': png(),
      };
      const data = `data:image/png;base64,${PNG.toString('base64')}`;
      for (const [name, lines] of Object.entries(pages)) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, lines.join('\n'));
        const {fetch} = fetchFrom(images);
        const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
        const failed = (page.remoteImages?.failed ?? []).map(f => f.url);
        if (name === 'styled.jsx') {
          // The stylesheet still carries the image; the script keeps the address.
          expect(page.html).toContain(`url("${data}")`);
          expect(
            page.warnings.some(w => w.message.includes('could not fetch')),
          ).toBe(false);
          expect(failed).toEqual(['https://cdn.example.com/a.png']);
        } else if (name === 'pushed.jsx') {
          expect(
            page.warnings.some(
              w =>
                w.code === 'remote-asset' && w.message.includes('cannot trace'),
            ),
          ).toBe(true);
          expect(page.html.slice(page.html.lastIndexOf('<script>'))).toContain(
            'https://cdn.example.com/b.png',
          );
        } else {
          expect(failed).toEqual(
            expect.arrayContaining([
              'https://cdn.example.com/s1.png',
              'https://cdn.example.com/s2.png',
            ]),
          );
          expect(page.remoteImages?.fetched ?? []).not.toContain(
            'https://cdn.example.com/s1.png',
          );
        }
      }
    } finally {
      removeLinkedFixture(dir);
    }
  }, 180_000);

  it('treats a JSON value and a destructured name as untraced, and still carries a kept address a stylesheet names', async () => {
    const dir = makeLinkedFixture('astryx-render-url-api-more-', [
      'react',
      'react-dom',
    ]);
    try {
      fs.writeFileSync(
        path.join(dir, 'data.json'),
        JSON.stringify({hero: 'https://cdn.example.com/h.png'}),
      );
      fs.writeFileSync(
        path.join(dir, 'kept.css'),
        '.k { background-image: url(https://cdn.example.com/k.png); }\n',
      );
      const pages = {
        'json.jsx': [
          "import data from './data.json';",
          'export default function Page() {',
          '  const url = new URL(data.hero);',
          "  url.searchParams.set('w', '480');",
          '  return <main><img src={data.hero} alt="Hero" /><p>{url.href}</p></main>;',
          '}',
          '',
        ],
        'destructured.jsx': [
          "const product = {photos: ['https://cdn.example.com/h.png']};",
          'const {photos} = product;',
          'export default function Page() {',
          '  const url = new URL(photos[0]);',
          "  url.searchParams.set('w', '480');",
          '  return <main><p>{url.href}</p></main>;',
          '}',
          '',
        ],
        'stylesheet.jsx': [
          "import './kept.css';",
          "const photo = 'https://cdn.example.com/k.png';",
          'export default function Page() {',
          '  const url = new URL(photo);',
          "  url.searchParams.set('w', '480');",
          '  return <main className="k"><p>{url.href}</p></main>;',
          '}',
          '',
        ],
      };
      const data = `data:image/png;base64,${PNG.toString('base64')}`;
      for (const [name, lines] of Object.entries(pages)) {
        const file = path.join(dir, name);
        fs.writeFileSync(file, lines.join('\n'));
        const {fetch} = fetchFrom({
          'https://cdn.example.com/h.png': png(),
          'https://cdn.example.com/k.png': png(),
        });
        const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
        const script = page.html.slice(page.html.lastIndexOf('<script>'));
        expect(script, name).not.toContain(`${data}#`);
        if (name === 'stylesheet.jsx') {
          expect(page.html).toContain(`url("${data}")`);
          expect(page.remoteImages?.failed.map(f => f.url)).toEqual([
            'https://cdn.example.com/k.png',
          ]);
        } else {
          expect(
            page.warnings.some(w => w.message.includes('cannot trace')),
            name,
          ).toBe(true);
        }
      }
    } finally {
      removeLinkedFixture(dir);
    }
  }, 180_000);

  it('keeps an address the URL API takes as a base as written', async () => {
    const dir = makeLinkedFixture('astryx-render-url-api-base-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "const hero = 'https://cdn.example.com/dir/hero.png';",
          'export default function Page() {',
          "  const thumb = new URL('thumb.png', hero);",
          '  return <main><img src={hero} alt="Hero" /><p>{thumb.href}</p></main>;',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch} = fetchFrom({
        'https://cdn.example.com/dir/hero.png': png(),
      });
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      const data = `data:image/png;base64,${PNG.toString('base64')}`;
      const script = page.html.slice(page.html.lastIndexOf('<script>'));
      // A data: URI cannot be a base, so the script keeps the address.
      expect(script).toContain('https://cdn.example.com/dir/hero.png');
      expect(script).not.toContain(`${data}#`);
      expect(
        page.warnings.some(w =>
          w.message.startsWith(
            "'https://cdn.example.com/dir/hero.png' (page.jsx:1) is an image address the page changes with the URL API",
          ),
        ),
      ).toBe(true);
      expect(page.remoteImages?.failed.map(f => f.url)).toEqual([
        'https://cdn.example.com/dir/hero.png',
      ]);
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('gives no warning for an untraced URL API call when the page names no remote image', async () => {
    const dir = makeLinkedFixture('astryx-render-url-api-none-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        'export default function Page() { return <main><button onClick={() => console.log(new URL(window.location.href).hash)}>Go</button></main>; }\n',
      );
      const {fetch} = fetchFrom({});
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(page.warnings.filter(w => w.code === 'remote-asset')).toEqual([]);
      expect(page.remoteImages).toBeUndefined();
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('reads new globalThis.URL as the URL API', async () => {
    const dir = makeLinkedFixture('astryx-render-url-api-global-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          "const photo = 'https://cdn.example.com/g.png';",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  const url = new globalThis.URL(photo);',
          "  url.searchParams.set('w', '200');",
          '  return <main><button onClick={() => setOpen(true)}>Show</button>{open && <img src={url.href} alt="" />}</main>;',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch, asked} = fetchFrom({
        'https://cdn.example.com/g.png': png(),
      });
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(asked).toEqual([]);
      expect(page.html.slice(page.html.lastIndexOf('<script>'))).toContain(
        'https://cdn.example.com/g.png',
      );
      const messages = page.warnings
        .filter(w => w.code === 'remote-asset')
        .map(w => w.message);
      expect(
        messages.some(m =>
          m.startsWith(
            "'https://cdn.example.com/g.png' (page.jsx:2) is an image address the page changes with the URL API",
          ),
        ),
      ).toBe(true);
      expect(messages.some(m => m.includes('cannot trace'))).toBe(false);
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('names the whole address of first-paint images that differ only by their query', async () => {
    const dir = makeLinkedFixture('astryx-render-query-two-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        'export default function Page() { return <main><img src="https://example.com/a.png?w=1" alt="" /><img src="https://example.com/a.png?w=2" alt="" /></main>; }\n',
      );
      const {fetch} = fetchFrom({});
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      const messages = page.warnings
        .filter(w => w.code === 'remote-asset')
        .map(w => w.message);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain('https://example.com/a.png?w=1');
      expect(messages[1]).toContain('https://example.com/a.png?w=2');
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('warns once for a first-paint image whose address has a query', async () => {
    const dir = makeLinkedFixture('astryx-render-query-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        'export default function Page() { return <img src="https://example.com/a.png?w=2" alt="" />; }\n',
      );
      const {fetch} = fetchFrom({});
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(page.warnings.filter(w => w.code === 'remote-asset')).toHaveLength(
        1,
      );
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('warns for an image the script draws later when its fetch fails', async () => {
    const dir = makeLinkedFixture('astryx-render-late-fail-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        [
          "import {useState} from 'react';",
          "const user = {avatarUrl: 'https://example.com/me'};",
          'export default function Page() {',
          '  const [open, setOpen] = useState(false);',
          '  return <main><button onClick={() => setOpen(true)}>Me</button>{open && <img src={user.avatarUrl} alt="Me" />}</main>;',
          '}',
          '',
        ].join('\n'),
      );
      const {fetch} = fetchFrom({});
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(page.warnings).toContainEqual({
        code: 'remote-asset',
        message:
          "https://example.com/me, which the page's code names as an image, is loaded from the network when the script draws it, which a sandboxed page cannot reach; save it beside the page and import it instead. The render could not fetch it: the network could not reach it.",
      });
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('keeps the address and says why when the network cannot reach it', async () => {
    const dir = makeLinkedFixture('astryx-render-offline-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        'export default function Page() { return <img src="https://example.com/away.png" alt="Away" />; }\n',
      );
      const {fetch} = fetchFrom({});
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      expect(renderedMarkupOf(page.html)).toContain(
        'src="https://example.com/away.png"',
      );
      expect(page.remoteImages).toEqual({
        fetched: [],
        failed: [
          {
            url: 'https://example.com/away.png',
            reason: 'the network could not reach it',
          },
        ],
      });
      expect(page.warnings).toContainEqual({
        code: 'remote-asset',
        message:
          'https://example.com/away.png is loaded from the network, which a sandboxed page cannot reach; save it beside the page and import it instead. The render could not fetch it: the network could not reach it.',
      });
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('carries the images a feed shows after a click, fetches no link, and warns for an address built in code', async () => {
    const dir = makeLinkedFixture('astryx-render-remote-late-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      const source = [
        "import {useState} from 'react';",
        'const feed = [',
        "  {name: 'Alex', avatarUrl: 'https://i.example.com/40?u=alex', docsUrl: 'https://example.com/guide'},",
        "  {name: 'Jo', avatarUrl: 'https://i.example.com/40?u=jo', docsUrl: 'https://example.com/api/items'},",
        '];',
        "const cover = {photoUrl: 'https://example.com/not-really-an-image'};",
        'export default function Page() {',
        '  const [open, setOpen] = useState(false);',
        '  return (',
        '    <main>',
        '      <button type="button" onClick={() => setOpen(true)}>Show the feed</button>',
        '      {open && feed.map(item => (',
        '        <p key={item.name}>',
        '          <img src={item.avatarUrl} alt={item.name} />',
        '          <img src={`https://i.example.com/40?u=${item.name}&big=1`} alt={`${item.name} large`} />',
        '          <a href={item.docsUrl}>Guide</a>',
        '        </p>',
        '      ))}',
        '      {open && <img src={cover.photoUrl} alt="Cover" />}',
        '    </main>',
        '  );',
        '}',
        '',
      ].join('\n');
      fs.writeFileSync(file, source);
      const {fetch, asked} = fetchFrom({
        'https://i.example.com/40?u=alex': png(),
        'https://i.example.com/40?u=jo': png(),
        'https://example.com/not-really-an-image': respond('<html></html>', {
          headers: {'content-type': 'text/html'},
        }),
      });
      const page = await renderPage(file, {cwd: dir, remoteImages: {fetch}});
      // A link or an API address is never fetched; only image-named literals are.
      expect(asked.map(a => a.url).sort()).toEqual([
        'https://example.com/not-really-an-image',
        'https://i.example.com/40?u=alex',
        'https://i.example.com/40?u=jo',
      ]);
      expect(page.remoteImages).toEqual({
        fetched: [
          'https://i.example.com/40?u=alex',
          'https://i.example.com/40?u=jo',
        ],
        failed: [
          {
            url: 'https://example.com/not-really-an-image',
            reason: 'not an image',
          },
        ],
      });
      expect(page.warnings).toContainEqual({
        code: 'remote-asset',
        message:
          '`https://i.example.com/40?u=${item.name}&big=1` (page.jsx:15) builds an image address in code, so the render cannot carry it: the file asks the network for it when the script draws it. Write the address whole, or save the image beside the page and import it.',
      });
      // Opened after the click, offline: the avatars draw from the carried data.
      fs.writeFileSync(path.join(dir, 'page.html'), page.html);
      const dom = new JSDOM(page.html, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
      });
      const settle = () =>
        new Promise(resolve => dom.window.setTimeout(resolve, 100));
      await settle();
      const doc = dom.window.document;
      expect(doc.querySelectorAll(`#${ROOT_ID} img`)).toHaveLength(0);
      /** @type {HTMLButtonElement} */ (
        doc.querySelector(`#${ROOT_ID} button`)
      ).click();
      await settle();
      const srcOf = (/** @type {string} */ alt) =>
        doc.querySelector(`#${ROOT_ID} img[alt="${alt}"]`)?.getAttribute('src');
      const data = `data:image/png;base64,${PNG.toString('base64')}`;
      // The script draws a carried address as its data: URI with an empty
      // fragment, which a data: URL ignores.
      expect(srcOf('Alex')).toBe(`${data}#`);
      expect(srcOf('Jo')).toBe(`${data}#`);
      expect(srcOf('Cover')).toBe('https://example.com/not-really-an-image');
      expect(doc.querySelector(`#${ROOT_ID} a`)?.getAttribute('href')).toBe(
        'https://example.com/guide',
      );
      dom.window.close();
      // The way back is the page as written.
      const back = /** @type {any} */ (
        await render('page.html', {
          cwd: dir,
          reverse: true,
          out: 'back/page.jsx',
        })
      );
      expect(back.data.exact).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'back/page.jsx'), 'utf8')).toBe(
        source,
      );
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);

  it('reaches no network in a markup-only render', async () => {
    const dir = makeLinkedFixture('astryx-render-markup-', [
      'react',
      'react-dom',
    ]);
    try {
      const file = path.join(dir, 'page.jsx');
      fs.writeFileSync(
        file,
        'export default function Page() { return <img src="https://example.com/shoe.png" alt="Shoe" />; }\n',
      );
      const {fetch, asked} = fetchFrom({'https://example.com/shoe.png': png()});
      const page = await renderPage(file, {
        cwd: dir,
        markupOnly: true,
        remoteImages: {fetch},
      });
      expect(asked).toEqual([]);
      expect(page.remoteImages).toBeUndefined();
    } finally {
      removeLinkedFixture(dir);
    }
  }, 120_000);
});
