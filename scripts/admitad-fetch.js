// scripts/admitad-fetch.js
// Исправленная версия: получаем goto_link через корректный эндпоинт deeplink
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// CONFIGURATION
// ============================================================
const BASE64_HEADER = process.env.BASE64_HEADER;
const WEBSITE_ID = process.env.ADMITAD_WEBSITE_ID; // 2929853
const SCOPE = process.env.ADMITAD_SCOPE || 'advcampaigns coupons';
const MAX_DESCRIPTION_LENGTH = 200;
const MIN_DESCRIPTION_LENGTH = 30;
const DEEPLINK_DELAY_MS = 150; // небольшая задержка между запросами

if (!BASE64_HEADER) {
  console.error('❌ Отсутствует BASE64_HEADER в переменных окружения');
  process.exit(1);
}
if (!WEBSITE_ID) {
  console.error('❌ Отсутствует ADMITAD_WEBSITE_ID');
  process.exit(1);
}

// Декодируем Base64
let clientId, clientSecret;
try {
  const decoded = Buffer.from(BASE64_HEADER, 'base64').toString('utf8');
  const parts = decoded.split(':');
  if (parts.length !== 2) throw new Error('Некорректный формат BASE64_HEADER');
  clientId = parts[0];
  clientSecret = parts[1];
  console.log(`🔑 Client ID: ${clientId.substring(0, 4)}...`);
} catch (error) {
  console.error('❌ Ошибка декодирования BASE64_HEADER:', error.message);
  process.exit(1);
}

// ============================================================
// CATEGORY KEYWORDS & MAPPING (как в оригинале)
// ============================================================
const CATEGORY_KEYWORDS = {
  autoparts: ['автозапчасти', 'запчасти', 'auto parts', 'автодетали', 'spare parts', 'автомагазин'],
  autoinsurance: ['страхование', 'осаго', 'каско', 'insurance', 'автострахование', 'страховка', 'полис'],
  tires: ['шины', 'покрышки', 'tires', 'автошины', 'резина', 'диски', 'wheels'],
  checkauto: ['проверка авто', 'автокод', 'vin', 'car check', 'история авто', 'проверка vin', 'отчет'],
  autorent: ['прокат авто', 'аренда авто', 'car rental', 'rent a car', 'каршеринг', 'аренда машины'],
  tools: ['инструменты', 'tools', 'автоинструмент', 'гараж', 'оборудование', 'диагностика'],
  coupons: ['купон', 'coupon', 'промокод', 'скидка', 'discount', 'акция', 'распродажа'],
};

const CATEGORY_NAMES = {
  autoparts: 'Автозапчасти',
  autoinsurance: 'Автострахование',
  tires: 'Шины и диски',
  checkauto: 'Проверка авто',
  autorent: 'Прокат авто',
  tools: 'Инструменты',
  coupons: 'Купоны и скидки',
  other: 'Другое'
};

function detectCategory(program) {
  const text = `${program.name} ${program.description || ''} ${program.site_description || ''}`.toLowerCase();
  const priorityOrder = ['autoparts', 'autoinsurance', 'tires', 'checkauto', 'autorent', 'tools', 'coupons'];
  for (const catId of priorityOrder) {
    if (CATEGORY_KEYWORDS[catId].some(kw => text.includes(kw.toLowerCase()))) return catId;
  }
  return 'other';
}

function extractImages(program) {
  const imageKeys = ['image', 'image_url', 'logo', 'advertiser_logo', 'brand_logo', 'icon', 'favicon'];
  let bestImage = null;
  for (const key of imageKeys) {
    const val = program[key];
    if (val && typeof val === 'string' && (val.startsWith('http://') || val.startsWith('https://'))) {
      if (!bestImage) bestImage = val;
    }
  }
  const finalImage = bestImage || '';
  return {
    image: finalImage,
    image_url: finalImage,
    logo: finalImage,
    icon: program.icon || '',
    favicon: program.favicon || '',
    advertiser_logo: finalImage,
    brand_logo: finalImage
  };
}

function cleanHTML(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function generateAdDescription(program) {
  const raw = [program.site_description, program.advertiser_description, program.description].filter(Boolean);
  let best = raw.find(d => d.length >= MIN_DESCRIPTION_LENGTH) || '';
  if (!best) best = `${program.name} — ${CATEGORY_NAMES[detectCategory(program)] || 'партнерская программа'}. Выгодные предложения, скидки и акции.`;
  if (best.length > MAX_DESCRIPTION_LENGTH) best = best.substring(0, MAX_DESCRIPTION_LENGTH).replace(/\s+\S*$/, '...');
  return {
    site_description: cleanHTML(program.site_description || ''),
    advertiser_description: cleanHTML(program.advertiser_description || ''),
    description: cleanHTML(program.description || ''),
    ad_text: best
  };
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9а-яё]+/g, '-').replace(/^-|-$/g, '').substring(0, 50);
}

// ============================================================
// API FUNCTIONS
// ============================================================
async function fetchAccessToken() {
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('scope', SCOPE);
  const response = await fetch('https://api.admitad.com/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SochiAutoParts/1.0' },
    body: params.toString(),
  });
  if (!response.ok) throw new Error(`Ошибка токена: ${response.status}`);
  const data = await response.json();
  console.log('✅ Токен получен');
  return data.access_token;
}

async function fetchAdvertiserInfo(advertiserId, accessToken) {
  try {
    const res = await fetch(`https://api.admitad.com/advertiser/${advertiserId}/info/`, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': 'SochiAutoParts/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { name: data.name || '', inn: data.inn || '' };
  } catch { return null; }
}

// ============================================================
// ✅ ИСПРАВЛЕННАЯ ФУНКЦИЯ ПОЛУЧЕНИЯ GOTO_LINK
// ============================================================
async function fetchGotoLink(websiteId, campaignId, accessToken) {
  // Пробуем два варианта URL (документация иногда отличается)
  const urls = [
    `https://api.admitad.com/deeplink/${websiteId}/advcampaign/${campaignId}/`,
    `https://api.admitad.com/deeplink/advcampaign/${campaignId}/?website=${websiteId}`
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': 'SochiAutoParts/1.0'
        },
      });
      if (response.ok) {
        const data = await response.json();
        // Ответ может быть массивом объектов с полем link
        if (Array.isArray(data) && data.length > 0 && data[0].link) {
          return data[0].link;
        }
        // Или объектом с полем link
        if (data.link) return data.link;
        // Иногда поле называется goto_link или gotolink
        if (data.goto_link) return data.goto_link;
        if (data.gotolink) return data.gotolink;
        // Логируем, чтобы понять структуру
        console.warn(`⚠️ Неожиданный ответ для campaign ${campaignId}:`, JSON.stringify(data).substring(0, 200));
        return '';
      } else {
        // Если 404, пробуем следующий URL
        if (response.status === 404) continue;
        console.warn(`⚠️ Ошибка ${response.status} для ${url}`);
        return '';
      }
    } catch (err) {
      console.warn(`⚠️ Ошибка запроса ${url}: ${err.message}`);
    }
  }
  console.warn(`❌ Не удалось получить goto_link для кампании ${campaignId} (оба варианта)`);
  return '';
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  try {
    const accessToken = await fetchAccessToken();

    // Загружаем список программ
    let campaignsUrl = `https://api.admitad.com/advcampaigns/?limit=200&fields=id,name,site_url,description,commission,rating,epc,cookie_lifetime,image,logo,advertiser_name,regions&website=${WEBSITE_ID}`;
    console.log(`📡 Загрузка программ для площадки ${WEBSITE_ID}...`);
    const campaignsRes = await fetch(campaignsUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': 'SochiAutoParts/1.0' }
    });
    if (!campaignsRes.ok) throw new Error(`Ошибка загрузки программ: ${campaignsRes.status}`);
    const campaignsData = await campaignsRes.json();
    const allPrograms = campaignsData.results || [];
    console.log(`📊 Получено программ: ${allPrograms.length}`);

    // Загружаем купоны
    console.log('🎫 Загрузка купонов...');
    let allCoupons = [];
    try {
      const couponsRes = await fetch(`https://api.admitad.com/coupons/?limit=500&has_affiliate_link=true`, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': 'SochiAutoParts/1.0' }
      });
      if (couponsRes.ok) {
        const couponsData = await couponsRes.json();
        allCoupons = couponsData.results || [];
        console.log(`🎫 Получено купонов: ${allCoupons.length}`);
      }
    } catch (e) { console.warn(`⚠️ Ошибка купонов: ${e.message}`); }

    const advertiserCache = new Map();
    const processedPrograms = [];
    let imagesFound = 0, descriptionsGenerated = 0, gotoLinksFound = 0;

    console.log('🔄 Обработка программ и получение goto_link...');
    for (let i = 0; i < allPrograms.length; i++) {
      const prog = allPrograms[i];
      
      // Юридическая информация
      let legalInfo = { name: prog.advertiser_name || prog.name || '', inn: '' };
      if (prog.advertiser_id && !advertiserCache.has(prog.advertiser_id)) {
        const info = await fetchAdvertiserInfo(prog.advertiser_id, accessToken);
        advertiserCache.set(prog.advertiser_id, info);
      }
      const cached = advertiserCache.get(prog.advertiser_id);
      if (cached) legalInfo.inn = cached.inn || '';

      let allowedRegions = (prog.regions || []).map(r => r.region || r).filter(Boolean);
      const programCoupons = allCoupons.filter(c => c.campaign?.id === prog.id);
      const category = detectCategory(prog);
      const images = extractImages(prog);
      if (images.image) imagesFound++;
      const descriptions = generateAdDescription(prog);
      if (descriptions.ad_text) descriptionsGenerated++;

      // Получаем партнёрскую ссылку
      console.log(`🔗 Запрос deeplink для ${prog.id} (${prog.name})...`);
      const gotoLink = await fetchGotoLink(WEBSITE_ID, prog.id, accessToken);
      if (gotoLink) {
        gotoLinksFound++;
        console.log(`   ✅ Получена ссылка: ${gotoLink.substring(0, 80)}...`);
      } else {
        console.log(`   ❌ Ссылка не получена`);
      }

      processedPrograms.push({
        id: prog.id,
        name: prog.name,
        slug: slugify(prog.name),
        ...images,
        ...descriptions,
        goto_link: gotoLink,
        site_url: prog.site_url || '',
        category,
        category_name: CATEGORY_NAMES[category] || 'Другое',
        advertiser_legal_info: legalInfo,
        commission: prog.commission || null,
        rating: prog.rating || 0,
        epc: prog.epc || 0,
        products_count: prog.products_count || 0,
        cookie_lifetime: prog.cookie_lifetime || 30,
        allowed_regions: allowedRegions,
        coupons: programCoupons.slice(0, 5).map(c => ({
          id: c.id,
          name: c.name,
          promocode: c.promocode,
          description: cleanHTML(c.description),
          discount: c.discount,
          date_start: c.date_start,
          date_end: c.date_end,
          goto_link: c.goto_link
        }))
      });

      await new Promise(resolve => setTimeout(resolve, DEEPLINK_DELAY_MS));
    }

    console.log(`✅ Обработано: ${processedPrograms.length} программ`);
    console.log(`🔗 Получено goto_link: ${gotoLinksFound}/${processedPrograms.length}`);

    // Группировка по регионам (как в оригинале)
    const REGION_GROUPS = {
      ru: { name: 'Россия', countries: ['RU'] },
      by: { name: 'Беларусь', countries: ['BY'] },
      kz: { name: 'Казахстан', countries: ['KZ'] },
      global: { name: 'Глобал', countries: [] }
    };
    const regionGroups = {};
    for (const key of Object.keys(REGION_GROUPS)) {
      regionGroups[key] = { id: key, name: REGION_GROUPS[key].name, programs: [] };
    }
    for (const prog of processedPrograms) {
      let assigned = false;
      for (const [groupKey, groupDef] of Object.entries(REGION_GROUPS)) {
        if (groupKey === 'global') continue;
        if (prog.allowed_regions.length === 0 || prog.allowed_regions.some(r => groupDef.countries.includes(r))) {
          regionGroups[groupKey].programs.push(prog);
          assigned = true;
        }
      }
      if (!assigned) regionGroups.global.programs.push(prog);
    }
    for (const key of Object.keys(regionGroups)) {
      const unique = Array.from(new Map(regionGroups[key].programs.map(p => [p.id, p])).values());
      regionGroups[key].programs = unique;
      regionGroups[key].count = unique.length;
    }

    // Сохраняем результат
    const outputData = {
      last_updated: new Date().toISOString(),
      website_id: WEBSITE_ID,
      total_programs: processedPrograms.length,
      images_found: imagesFound,
      descriptions_generated: descriptionsGenerated,
      goto_links_found: gotoLinksFound,
      programs: processedPrograms,
      region_groups: regionGroups,
      categories: Object.keys(CATEGORY_KEYWORDS)
    };

    const dataDir = path.join(__dirname, '..', 'data');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'admitad_ads.json'), JSON.stringify(outputData, null, 2));
    console.log(`💾 Файл сохранён в data/admitad_ads.json`);
    console.log('🎉 Парсинг завершён!');
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

main();
