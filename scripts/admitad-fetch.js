// scripts/admitad-fetch.js
// ES module syntax - requires "type": "module" in package.json
// ПАРСЕР ADMITAD: Проксирует изображения через /m/<hash>, обновляет media_map.json

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// CONFIGURATION
// ============================================================
const BASE64_HEADER = process.env.BASE64_HEADER;
const WEBSITE_ID = process.env.ADMITAD_WEBSITE_ID;
const SCOPE = process.env.ADMITAD_SCOPE || 'advcampaigns coupons';
const SITE_URL = 'https://sochiautoparts.ru';
const MAX_DESCRIPTION_LENGTH = 200;
const MIN_DESCRIPTION_LENGTH = 30;

if (!BASE64_HEADER) {
  console.error('❌ Отсутствует BASE64_HEADER в переменных окружения');
  process.exit(1);
}

// Декодируем Base64
let clientId, clientSecret;
try {
  const decoded = Buffer.from(BASE64_HEADER, 'base64').toString('utf8');
  const parts = decoded.split(':');
  if (parts.length !== 2) {
    throw new Error('Некорректный формат BASE64_HEADER: ожидается "client_id:client_secret"');
  }
  clientId = parts[0];
  clientSecret = parts[1];
  console.log(`🔑 Client ID (первые 4): ${clientId.substring(0, 4)}...`);
} catch (error) {
  console.error('❌ Ошибка декодирования BASE64_HEADER:', error.message);
  process.exit(1);
}

// ============================================================
// HASH FUNCTION (MUST MATCH WORKER)
// ============================================================
function generateMediaHash(url) {
  if (!url || typeof url !== 'string') return '0';
  let hash = 2166136261;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(36);
}

function getProxyMediaUrl(originalUrl) {
  if (!originalUrl) return SITE_URL + '/logo.png';
  const hash = generateMediaHash(originalUrl);
  return SITE_URL + '/m/' + hash;
}

// ============================================================
// LOAD & SAVE MEDIA MAP
// ============================================================
async function loadExistingMediaMap(dataDir) {
  const mediaMapPath = path.join(dataDir, 'media_map.json');
  try {
    const content = await fs.readFile(mediaMapPath, 'utf8');
    const map = JSON.parse(content);
    console.log(`📥 Загружено существующих записей в media_map: ${Object.keys(map).length}`);
    return map;
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('📥 media_map.json не найден, создаём новый');
      return {};
    }
    console.warn(`⚠️ Ошибка чтения media_map.json: ${e.message}`);
    return {};
  }
}

async function saveMediaMap(dataDir, mediaMap) {
  const mediaMapPath = path.join(dataDir, 'media_map.json');
  await fs.writeFile(mediaMapPath, JSON.stringify(mediaMap, null, 2));
  console.log(`💾 media_map.json сохранён: ${Object.keys(mediaMap).length} записей`);
}

// ============================================================
// CATEGORY KEYWORDS & MAPPING
// ============================================================
const CATEGORY_KEYWORDS = {
  autoparts: ['автозапчасти', 'запчасти', 'auto parts', 'автодетали', 'запчасть', 'spare parts', 'автомагазин'],
  autoinsurance: ['страхование', 'осаго', 'каско', 'insurance', 'автострахование', 'страховка', 'полис'],
  tires: ['шины', 'покрышки', 'tires', 'автошины', 'резина', 'диски', 'wheels', 'колеса'],
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
    const keywords = CATEGORY_KEYWORDS[catId];
    if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
      return catId;
    }
  }
  
  const adCat = (program.category || '').toLowerCase();
  if (adCat.includes('auto') || adCat.includes('car') || adCat.includes('vehicle')) {
    return 'autoparts';
  }
  
  return 'other';
}

// ============================================================
// IMAGE EXTRACTION & PROXY
// ============================================================
function extractAndProxyImages(program, mediaMap) {
  const imageKeys = [
    'image',
    'image_url', 
    'logo',
    'advertiser_logo',
    'brand_logo',
    'icon',
    'favicon'
  ];
  
  let bestImage = null;
  let fallbackImage = null;
  
  for (const key of imageKeys) {
    const value = program[key];
    if (value && typeof value === 'string' && value.trim() !== '') {
      const url = value.trim();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const hash = generateMediaHash(url);
        const proxyUrl = getProxyMediaUrl(url);
        
        // Добавляем в карту (сохраняем существующие записи)
        if (!mediaMap[hash]) {
          mediaMap[hash] = url;
        }
        
        if (!bestImage) {
          bestImage = proxyUrl;
        }
        if (key === 'logo' || key === 'advertiser_logo') {
          fallbackImage = proxyUrl;
        }
      }
    }
  }
  
  return {
    image: bestImage || '',
    image_url: bestImage || '',
    logo: fallbackImage || bestImage || '',
    icon: program.icon || program.favicon || '',
    favicon: program.favicon || '',
    advertiser_logo: fallbackImage || bestImage || '',
    brand_logo: fallbackImage || bestImage || ''
  };
}

// ============================================================
// DESCRIPTION GENERATION
// ============================================================
function cleanHTML(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function generateAdDescription(program) {
  const rawDescriptions = [
    program.site_description,
    program.advertiser_description,
    program.description,
    program.short_description
  ];
  
  let bestDescription = '';
  
  for (const desc of rawDescriptions) {
    const cleaned = cleanHTML(desc);
    if (cleaned.length >= MIN_DESCRIPTION_LENGTH) {
      bestDescription = cleaned;
      break;
    }
  }
  
  if (!bestDescription || bestDescription.length < MIN_DESCRIPTION_LENGTH) {
    bestDescription = `${program.name} — ${CATEGORY_NAMES[detectCategory(program)] || 'партнерская программа'}. ` +
                      `Выгодные предложения, скидки и акции. Переходите и узнайте подробнее!`;
  }
  
  if (bestDescription.length > MAX_DESCRIPTION_LENGTH) {
    const truncated = bestDescription.substring(0, MAX_DESCRIPTION_LENGTH);
    const lastSpace = truncated.lastIndexOf(' ');
    bestDescription = (lastSpace > 50 ? truncated.substring(0, lastSpace) : truncated) + '...';
  }
  
  return {
    site_description: cleanHTML(program.site_description) || '',
    advertiser_description: cleanHTML(program.advertiser_description) || '',
    description: cleanHTML(program.description) || '',
    ad_text: bestDescription
  };
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9а-яё]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
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

  console.log(`🔐 Запрос токена со scope: ${SCOPE}`);
  const response = await fetch('https://api.admitad.com/token/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SOCHIAUTOPARTS-Parser/2.0',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ошибка получения токена: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  console.log('✅ Токен получен');
  return data.access_token;
}

async function fetchAdvertiserInfo(advertiserId, accessToken) {
  try {
    const response = await fetch(`https://api.admitad.com/advertiser/${advertiserId}/info/`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'SOCHIAUTOPARTS-Parser/2.0',
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      name: data.name || data.company_name || '',
      inn: data.inn || data.tax_id || ''
    };
  } catch {
    return null;
  }
}

// ============================================================
// MAIN PROCESSING
// ============================================================
async function main() {
  try {
    const accessToken = await fetchAccessToken();

    let campaignsUrl = `https://api.admitad.com/advcampaigns/?limit=200`;
    if (WEBSITE_ID) {
      campaignsUrl += `&website=${WEBSITE_ID}`;
      console.log(`📡 Загрузка программ для площадки ${WEBSITE_ID}...`);
    } else {
      console.log('📡 Загрузка всех доступных программ...');
    }

    const campaignsResponse = await fetch(campaignsUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'SOCHIAUTOPARTS-Parser/2.0',
      },
    });

    if (!campaignsResponse.ok) {
      throw new Error(`Ошибка загрузки программ: ${campaignsResponse.status}`);
    }

    const campaignsData = await campaignsResponse.json();
    const allPrograms = campaignsData.results || [];
    console.log(`📊 Получено программ: ${allPrograms.length}`);

    console.log('🎫 Загрузка купонов...');
    let allCoupons = [];
    try {
      const couponsResponse = await fetch(
        `https://api.admitad.com/coupons/?limit=500&has_affiliate_link=true`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'User-Agent': 'SOCHIAUTOPARTS-Parser/2.0',
          },
        }
      );
      if (couponsResponse.ok) {
        const couponsData = await couponsResponse.json();
        allCoupons = couponsData.results || [];
        console.log(`🎫 Получено купонов: ${allCoupons.length}`);
      }
    } catch (e) {
      console.warn(`⚠️ Ошибка купонов: ${e.message}`);
    }

    const dataDir = path.join(__dirname, '..', 'data');
    await fs.mkdir(dataDir, { recursive: true });

    // Загружаем существующую карту медиа
    const mediaMap = await loadExistingMediaMap(dataDir);
    const initialMapSize = Object.keys(mediaMap).length;

    const advertiserCache = new Map();
    const processedPrograms = [];
    let imagesFound = 0;
    let descriptionsGenerated = 0;

    console.log('🔄 Обработка программ и проксирование изображений...');
    for (const prog of allPrograms) {
      let legalInfo = {
        name: prog.advertiser_name || prog.name || '',
        inn: prog.advertiser_inn || ''
      };

      if (!legalInfo.inn && prog.advertiser_id) {
        if (!advertiserCache.has(prog.advertiser_id)) {
          const info = await fetchAdvertiserInfo(prog.advertiser_id, accessToken);
          advertiserCache.set(prog.advertiser_id, info);
        }
        const info = advertiserCache.get(prog.advertiser_id);
        if (info) {
          legalInfo.name = legalInfo.name || info.name;
          legalInfo.inn = info.inn || legalInfo.inn;
        }
      }

      let allowedRegions = [];
      if (prog.regions && Array.isArray(prog.regions)) {
        allowedRegions = prog.regions.map(r => r.region || r).filter(Boolean);
      }

      const programCoupons = allCoupons.filter(c => c.campaign?.id === prog.id);
      const category = detectCategory(prog);
      
      // Проксирование изображений и обновление mediaMap
      const images = extractAndProxyImages(prog, mediaMap);
      if (images.image) imagesFound++;

      const descriptions = generateAdDescription(prog);
      if (descriptions.ad_text) descriptionsGenerated++;

      processedPrograms.push({
        id: prog.id,
        name: prog.name,
        slug: slugify(prog.name),
        
        // Проксированные изображения
        ...images,
        
        // Описания
        site_description: descriptions.site_description,
        advertiser_description: descriptions.advertiser_description,
        description: descriptions.description,
        ad_text: descriptions.ad_text,
        
        goto_link: prog.goto_link || prog.site_url || '',
        site_url: prog.site_url || '',
        
        category: category,
        category_name: CATEGORY_NAMES[category] || 'Другое',
        
        advertiser_legal_info: {
          name: legalInfo.name,
          inn: legalInfo.inn
        },
        
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
    }

    console.log(`✅ Обработано: ${processedPrograms.length} программ`);
    console.log(`🖼️  Найдено и проксировано изображений: ${imagesFound}/${processedPrograms.length}`);
    console.log(`📝 Сгенерировано описаний: ${descriptionsGenerated}/${processedPrograms.length}`);
    console.log(`🗺️  Добавлено записей в media_map: ${Object.keys(mediaMap).length - initialMapSize}`);

    // Группировка по регионам
    const REGION_GROUPS = {
      ru: { name: 'Россия', countries: ['RU'] },
      by: { name: 'Беларусь', countries: ['BY'] },
      kz: { name: 'Казахстан', countries: ['KZ'] },
      global: { name: 'Глобал', countries: [] }
    };

    const regionGroups = {};
    for (const key of Object.keys(REGION_GROUPS)) {
      regionGroups[key] = {
        id: key,
        name: REGION_GROUPS[key].name,
        programs: []
      };
    }

    for (const prog of processedPrograms) {
      let assigned = false;
      for (const [groupKey, groupDef] of Object.entries(REGION_GROUPS)) {
        if (groupKey === 'global') continue;
        if (prog.allowed_regions.length === 0 || 
            prog.allowed_regions.some(r => groupDef.countries.includes(r))) {
          regionGroups[groupKey].programs.push(prog);
          assigned = true;
        }
      }
      if (!assigned || prog.allowed_regions.length === 0) {
        regionGroups.global.programs.push(prog);
      }
    }

    for (const key of Object.keys(regionGroups)) {
      const unique = Array.from(new Map(regionGroups[key].programs.map(p => [p.id, p])).values());
      regionGroups[key].programs = unique;
      regionGroups[key].count = unique.length;
    }

    console.log('📊 Группировка по регионам:');
    for (const [key, group] of Object.entries(regionGroups)) {
      console.log(`  ${group.name}: ${group.count} программ`);
    }

    // Сохранение файлов
    const outputData = {
      last_updated: new Date().toISOString(),
      website_id: WEBSITE_ID || null,
      total_programs: processedPrograms.length,
      images_found: imagesFound,
      descriptions_generated: descriptionsGenerated,
      programs: processedPrograms,
      region_groups: regionGroups,
      categories: Object.keys(CATEGORY_KEYWORDS)
    };

    const adsPath = path.join(dataDir, 'admitad_ads.json');
    await fs.writeFile(adsPath, JSON.stringify(outputData, null, 2));
    await saveMediaMap(dataDir, mediaMap);

    console.log(`💾 admitad_ads.json сохранён: ${adsPath}`);
    console.log('🎉 Парсинг завершён успешно!');
    console.log('\n📋 Следующие шаги:');
    console.log('   1. Закоммитьте оба файла в GitHub:');
    console.log('      git add data/admitad_ads.json data/media_map.json');
    console.log('      git commit -m "Update Admitad data with proxied images"');
    console.log('      git push');
    console.log('   2. Очистите кэш Worker:');
    console.log('      curl https://sochiautoparts.ru/api/cache/clear');
    console.log('   3. Проверьте отображение рекламных блоков на сайте.');

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

main();
