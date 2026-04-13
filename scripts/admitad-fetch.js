// scripts/admitad-fetch.js
// ES module syntax - requires "type": "module" in package.json
// ПАРСЕР ADMITAD: Получает goto_link через эндпоинт /offers/

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

if (!BASE64_HEADER) {
  console.error('❌ Отсутствует BASE64_HEADER в переменных окружения');
  process.exit(1);
}

if (!WEBSITE_ID) {
  console.warn('⚠️ ADMITAD_WEBSITE_ID не задан, goto_link может отсутствовать');
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
// IMAGE EXTRACTION
// ============================================================
function extractImages(program) {
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
        if (!bestImage) {
          bestImage = url;
        }
        if (key === 'logo' || key === 'advertiser_logo') {
          fallbackImage = url;
        }
      }
    }
  }
  
  const finalImage = bestImage || '';
  const finalLogo = fallbackImage || bestImage || '';
  
  return {
    image: finalImage,
    image_url: finalImage,
    logo: finalLogo,
    icon: program.icon || program.favicon || '',
    favicon: program.favicon || '',
    advertiser_logo: finalLogo,
    brand_logo: finalLogo
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
// MAIN PROCESSING - ИСПОЛЬЗУЕМ /offers/ ВМЕСТО /advcampaigns/
// ============================================================
async function main() {
  try {
    const accessToken = await fetchAccessToken();

    // ✅ ПРАВИЛЬНЫЙ ЭНДПОИНТ: /offers/ с website и полем gotolink
    let offersUrl = `https://api.admitad.com/offers/?limit=200&fields=id,name,site_url,gotolink,description,commission,rating,epc,cookie_lifetime,image,logo,advertiser_name,regions`;
    
    if (WEBSITE_ID) {
      offersUrl += `&website=${WEBSITE_ID}`;
      console.log(`📡 Загрузка офферов для площадки ${WEBSITE_ID}...`);
    } else {
      console.log('📡 Загрузка офферов (без website_id, goto_link может не быть)...');
    }

    const offersResponse = await fetch(offersUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'SOCHIAUTOPARTS-Parser/2.0',
      },
    });

    if (!offersResponse.ok) {
      throw new Error(`Ошибка загрузки офферов: ${offersResponse.status}`);
    }

    const offersData = await offersResponse.json();
    const allOffers = offersData.results || [];
    console.log(`📊 Получено офферов: ${allOffers.length}`);

    // Лог первого оффера для проверки gotolink
    if (allOffers.length > 0) {
      console.log('🔍 Пример первого оффера:', JSON.stringify({
        id: allOffers[0].id,
        name: allOffers[0].name,
        has_gotolink: !!allOffers[0].gotolink,
        gotolink_preview: allOffers[0].gotolink ? allOffers[0].gotolink.substring(0, 80) : 'ОТСУТСТВУЕТ'
      }, null, 2));
    }

    // Загрузка купонов (оставляем как есть)
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

    const advertiserCache = new Map();
    const processedPrograms = [];
    let imagesFound = 0;
    let descriptionsGenerated = 0;
    let gotoLinksFound = 0;

    console.log('🔄 Обработка офферов...');
    for (const offer of allOffers) {
      let legalInfo = {
        name: offer.advertiser_name || offer.name || '',
        inn: offer.advertiser_inn || ''
      };

      if (!legalInfo.inn && offer.advertiser_id) {
        if (!advertiserCache.has(offer.advertiser_id)) {
          const info = await fetchAdvertiserInfo(offer.advertiser_id, accessToken);
          advertiserCache.set(offer.advertiser_id, info);
        }
        const info = advertiserCache.get(offer.advertiser_id);
        if (info) {
          legalInfo.name = legalInfo.name || info.name;
          legalInfo.inn = info.inn || legalInfo.inn;
        }
      }

      let allowedRegions = [];
      if (offer.regions && Array.isArray(offer.regions)) {
        allowedRegions = offer.regions.map(r => r.region || r).filter(Boolean);
      }

      const programCoupons = allCoupons.filter(c => c.campaign?.id === offer.id);
      const category = detectCategory(offer);
      
      const images = extractImages(offer);
      if (images.image) imagesFound++;

      const descriptions = generateAdDescription(offer);
      if (descriptions.ad_text) descriptionsGenerated++;

      // ✅ gotolink - это и есть партнёрская ссылка
      const finalGotoLink = offer.gotolink || '';
      if (finalGotoLink) gotoLinksFound++;

      processedPrograms.push({
        id: offer.id,
        name: offer.name,
        slug: slugify(offer.name),
        
        ...images,
        
        site_description: descriptions.site_description,
        advertiser_description: descriptions.advertiser_description,
        description: descriptions.description,
        ad_text: descriptions.ad_text,
        
        goto_link: finalGotoLink,
        site_url: offer.site_url || '',
        
        category: category,
        category_name: CATEGORY_NAMES[category] || 'Другое',
        
        advertiser_legal_info: {
          name: legalInfo.name,
          inn: legalInfo.inn
        },
        
        commission: offer.commission || null,
        rating: offer.rating || 0,
        epc: offer.epc || 0,
        products_count: offer.products_count || 0,
        cookie_lifetime: offer.cookie_lifetime || 30,
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
    console.log(`🖼️  Найдено изображений: ${imagesFound}/${processedPrograms.length}`);
    console.log(`📝 Сгенерировано описаний: ${descriptionsGenerated}/${processedPrograms.length}`);
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

    // Сохранение JSON
    const outputData = {
      last_updated: new Date().toISOString(),
      website_id: WEBSITE_ID || null,
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
    
    const adsPath = path.join(dataDir, 'admitad_ads.json');
    await fs.writeFile(adsPath, JSON.stringify(outputData, null, 2));

    console.log(`💾 Файл сохранён: ${adsPath}`);
    console.log('🎉 Парсинг завершён успешно!');
    console.log('\n📋 Следующие шаги:');
    console.log('   1. Закоммитьте файл в GitHub:');
    console.log('      git add data/admitad_ads.json');
    console.log('      git commit -m "Update Admitad data with goto_link from /offers/"');
    console.log('      git push');
    console.log('   2. Очистите кэш Worker:');
    console.log('      curl https://sochiautoparts.ru/api/cache/clear');

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

main();
