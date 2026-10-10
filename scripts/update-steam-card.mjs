import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const readme = await readFile(new URL('README.md', root), 'utf8');
const cardUrl = readme.match(/https:\/\/github-readme-steam-card\.vercel\.app\/status\/\?[^\s)"<>]+/)?.[0];
if (!cardUrl) throw new Error('Steam card URL was not found in README.md');
const steamId = new URL(cardUrl).searchParams.get('steamid');
if (!/^\d{17}$/.test(steamId ?? '')) throw new Error('Invalid SteamID64');
const steamApiKey = process.env.STEAM_API_KEY?.trim();
if (!steamApiKey) throw new Error('STEAM_API_KEY is required. Add it as a repository Actions secret.');

function steamApiUrl(method, parameters) {
  const url = new URL(`https://api.steampowered.com/IPlayerService/${method}/v1/`);
  url.searchParams.set('key', steamApiKey);
  url.searchParams.set('input_json', JSON.stringify(parameters));
  return url;
}

async function request(url, type) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return type === 'json' ? await response.json() : type === 'bytes'
        ? Buffer.from(await response.arrayBuffer()) : await response.text();
    } catch (error) {
      if (attempt === 2) {
        const endpoint = new URL(url);
        const reason = /^HTTP \d+$/.test(error.message) ? error.message : 'Network request failed';
        throw new Error(`${reason}: ${endpoint.origin}${endpoint.pathname}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function parseRecentGame(data) {
  const games = data.response?.games;
  if (games === undefined) return null;
  if (!Array.isArray(games)) throw new Error('Unexpected Steam owned-games response');
  // rtime_last_played identifies the latest session, independently of total playtime.
  const latest = games.filter(game => Number.isInteger(game.appid) && game.appid > 0
    && typeof game.name === 'string' && game.name.trim()
    && Number.isFinite(game.rtime_last_played) && game.rtime_last_played > 0
    && Number.isFinite(game.playtime_forever) && game.playtime_forever >= 0)
    .sort((left, right) => right.rtime_last_played - left.rtime_last_played)[0];
  if (!latest) return null;
  return {
    appId: String(latest.appid),
    title: latest.name.trim(),
    hours: (latest.playtime_forever / 60).toLocaleString('en-US', { maximumFractionDigits: 1 }),
    thumbnail: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${latest.appid}/capsule_184x69.jpg`,
  };
}

const [sourceSvg, equipped, ownedGames] = await Promise.all([
  request(cardUrl, 'text'),
  request(steamApiUrl('GetProfileItemsEquipped', { steamid: steamId }), 'json'),
  request(steamApiUrl('GetOwnedGames', {
    steamid: steamId,
    include_appinfo: true,
    include_played_free_games: true,
  }), 'json'),
]);
if (!sourceSvg.includes('<svg') || !sourceSvg.includes('</svg>')) {
  throw new Error('Card service did not return an SVG');
}
const backgroundPath = equipped.response?.profile_background?.image_large;
if (!backgroundPath || !/^items\/[\w/.-]+$/.test(backgroundPath)) {
  throw new Error('No public Steam profile background was found');
}
const backgroundUrl = `https://shared.akamai.steamstatic.com/community_assets/images/${backgroundPath}`;
const background = await request(backgroundUrl, 'bytes');
const mime = background[0] === 0xff && background[1] === 0xd8 ? 'image/jpeg'
  : background.subarray(1, 4).toString() === 'PNG' ? 'image/png' : null;
if (!mime) throw new Error('Unsupported profile background image format');

// Replace the upstream background while keeping its animated avatar and status.
const withoutBackground = sourceSvg.replace(/<image\b(?=[^>]*\bx="0")(?=[^>]*\by="0")[^>]*\/>/g, '');
const baseRect = /<rect\b(?=[^>]*\bwidth="500")(?=[^>]*\bheight="200")[^>]*\/>/;
if (!baseRect.test(withoutBackground)) throw new Error('Unexpected Steam card layout');
const backgroundLayer = `<image href="data:${mime};base64,${background.toString('base64')}" x="0" y="0" width="500" height="200" preserveAspectRatio="xMidYMid slice" opacity="0.8" />\n<rect x="0" y="0" width="500" height="200" fill="#101822" opacity="0.2" />`;
let svg = withoutBackground.replace(baseRect, rectangle => `${rectangle}\n${backgroundLayer}`);
const recentGame = parseRecentGame(ownedGames);
const isPlaying = /class="game-header-status"[^>]*>In-Game<\/text>/.test(sourceSvg);
if (recentGame && !isPlaying) {
  let thumbnail = '';
  if (recentGame.thumbnail) {
    try {
      const bytes = await request(recentGame.thumbnail, 'bytes');
      const imageMime = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
        : bytes.subarray(1, 4).toString() === 'PNG' ? 'image/png' : null;
      if (imageMime) thumbnail = `<image x="174" y="103" width="112" height="42" preserveAspectRatio="xMidYMid meet" href="data:${imageMime};base64,${bytes.toString('base64')}" />`;
    } catch (error) {
      console.warn(`Recent game thumbnail unavailable: ${error.message}`);
    }
  }
  // Remove the upstream game artwork and labels; keep the profile background, avatar and frame.
  svg = svg.replace(/<image\b([^>]*?)\/>/g, (image, attributes) => {
    const x = attributes.match(/\bx="([^"]+)"/)?.[1];
    const y = attributes.match(/\by="([^"]+)"/)?.[1];
    return (x === '0' && y === '0') || (x === '20' && y === '36') || (x === '6' && y === '22') ? image : '';
  }).replace(/<text\b(?=[^>]*\bx="160")(?=[^>]*\by="(?:120|130|140|150|158)")[^>]*>[\s\S]*?<\/text>/g, '');
  const characters = Array.from(recentGame.title);
  const title = characters.length > 23 ? `${characters.slice(0, 22).join('')}…` : recentGame.title;
  const gameLayer = `<g>
    <title>${escapeXml(recentGame.title)} — ${escapeXml(recentGame.hours)} hours played</title>
    <rect x="162" y="82" width="320" height="91" rx="8" fill="#101822" opacity="0.8" />
    <text x="174" y="98" font-size="11" fill="#b9c8d7">최근 플레이</text>
    ${thumbnail}
    <text x="296" y="121" font-size="13" fill="#ffffff">${escapeXml(title)}</text>
    <text x="296" y="143" font-size="12" fill="#cbd6e2">누적 ${escapeXml(recentGame.hours)}시간</text>
  </g>`;
  svg = svg.replace('</g>', `</g>\n${gameLayer}`);
  console.log(`Recent game: ${recentGame.title}, ${recentGame.hours} hours played.`);
} else if (!recentGame) {
  console.log('No public recent game was found; keeping the upstream game display.');
}
await mkdir(new URL('assets/', root), { recursive: true });
const output = new URL('assets/steam-card.svg', root);
const temporary = new URL('assets/steam-card.svg.tmp', root);
await writeFile(temporary, svg, 'utf8');
await rename(temporary, output);
console.log(`Updated ${fileURLToPath(output)} with the equipped Steam profile background.`);