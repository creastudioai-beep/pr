// scripts/admitad-fetch.js
// ES module syntax - requires "type": "module" in package.json
// ПАРСЕР ADMITAD v3.0 - ТОЛЬКО РЕАЛЬНЫЕ ДАННЫЕ ИЗ API
// Без выдуманных описаний. Сохраняет оригинальные URL изображений.

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
const MAX_DESCRIPTION_LENGTH = 300;

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
// CATEGORY KEYWORDS & MAPPING (только для категоризации, не для описаний)
// ============================================================
const CATEGORY_KEYWORDS = {
  autoparts: ['автозапчасти', 'запчасти', 'auto parts', 'автодетали', 'spare parts', 'автомагазин'],
  autoinsurance: ['страхование', 'осаго', 'каско', 'insurance', 'автострахование', 'страховка'],
  tires: ['шины', 'покрышки', 'tires', 'автошины', 'резина', 'диски', 'wheels'],
  checkauto: ['проверка авто', 'автокод', 'vin', 'car check', 'история авто', 'проверка vin'],
  autorent: ['прокат авто', 'аренда авто', 'car rental', 'rent a car', 'каршеринг'],
  tools: ['инструменты', 'tools', 'автоинструмент', 'гараж', 'оборудование'],
  coupons: ['купон', 'coupon', 'промокод', 'скидка', 'discount', 'акция'],
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
  const text = `${program.name} ${program.description || ''} ${program.site_description || ''} ${program.advertiser_description || ''}`.toLowerCase();
  const priorityOrder = ['autoparts', 'autoinsurance', 'tires', 'checkauto', 'autorent', 'tools', 'coupons'];
  
  for (const catId of priorityOrder) {
    const keywords = CATEGORY_KEYWORDS[catId];
    if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
      return catId;
    }
  }
  return 'other';
}

// ============================================================
// ИЗВЛЕЧЕНИЕ ИЗОБРАЖЕНИЙ - ОРИГИНАЛЬНЫЕ URL
// ============================================================
function extractImages(program) {
  const imageKeys = ['image', 'image_url', 'logo', 'advertiser_logo', 'brand_logo', 'icon', 'favicon'];
  let bestImage = null;
  let fallbackImage = null;
  
  for (const key of imageKeys) {
    const value = program[key];
    if (value && typeof value === 'string' && value.trim() !== '') {
      const url = value.trim();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        if (!bestImage) bestImage = url;
        if (key === 'logo' || key === 'advertiser_logo') fallbackImage = url;
      }
    }
  }
  
  const finalImage = bestImage || '';
  const finalLogo = fallbackImage || bestImage || '';
  
  // Дублируем во все возможные поля, чтобы Worker находил через любой ключ
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
// ОЧИСТКА HTML – ТОЛЬКО ДЛЯ УДАЛЕНИЯ ТЕГОВ, БЕЗ ВЫДУМЫВАНИЯ
// ============================================================
function cleanHTML(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
// ПОЛУЧЕНИЕ ОПИСАНИЯ – ТОЛЬКО ИЗ API, БЕЗ ГЕНЕРАЦИИ
// ============================================================
function getRealDescription(program) {
  // Приоритет: site_description → advertiser_description → description → short_description
  const sources = [
    { field: program.site_description, name: 'site_description' },
    { field: program.advertiser_description, name: 'advertiser_description' },
    { field: program.description, name: 'description' },
    { field: program.short_description, name: 'short_description' },
  ];
  
  let bestDescription = '';
  let sourceUsed = '';
  
  for (const src of sources) {
    const cleaned = cleanHTML(src.field);
    if (cleaned && cleaned.length > 0) {
      bestDescription = cleaned;
      sourceUsed = src.name;
      break;
    }
  }
  
  // Если совсем нет описания – ставим пустую строку, НЕ выдумываем
  if (!bestDescription) {
    console.warn(`⚠️ Нет описания для программы ${program.name} (id: ${program.id})`);
    return {
      site_description: '',
      advertiser_description: '',
      description: '',
      short_description: '',
      ad_text: ''
    };
  }
  
  // Обрезаем до MAX_DESCRIPTION_LENGTH, но сохраняем смысл
  let truncated = bestDescription;
  if (bestDescription.length > MAX_DESCRIPTION_LENGTH) {
    truncated = bestDescription.substring(0, MAX_DESCRIPTION_LENGTH);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 50) {
      truncated = truncated.substring(0, lastSpace) + '...';
    } else {
      truncated = truncated + '...';
    }
  }
  
  return {
    site_description: bestDescription,
    advertiser_description: bestDescription,
    description: bestDescription,
    short_description: truncated.length > 120 ? truncated.substring(0, 120) + '...' : truncated,
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
// API ФУНКЦИИ
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
      'User-Agent': 'SOCHIAUTOPARTS-Parser/3.0',
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
        'User-Agent': 'SOCHIAUTOPARTS-Parser/3.0',
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
// ОСНОВНАЯ ЛОГИКА
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
        'User-Agent': 'SOCHIAUTOPARTS-Parser/3.0',
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
            'User-Agent': 'SOCHIAUTOPARTS-Parser/3.0',
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
    let descriptionsFound = 0;

    console.log('🔄 Обработка программ (только реальные данные из API)...');
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
      
      const images = extractImages(prog);
      if (images.image) imagesFound++;

      const descriptions = getRealDescription(prog);
      if (descriptions.site_description) descriptionsFound++;

      processedPrograms.push({
        id: prog.id,
        name: prog.name,
        slug: slugify(prog.name),
        
        // Оригинальные изображения (все поля)
        ...images,
        
        // Описания – ТОЛЬКО реальные данные из API
        site_description: descriptions.site_description,
        advertiser_description: descriptions.advertiser_description,
        description: descriptions.description,
        short_description: descriptions.short_description,
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
    console.log(`🖼️  Найдено изображений: ${imagesFound}/${processedPrograms.length}`);
    console.log(`📝 Найдено описаний: ${descriptionsFound}/${processedPrograms.length}`);

    // Группировка по регионам
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

    // Сохраняем JSON
    const outputData = {
      last_updated: new Date().toISOString(),
      website_id: WEBSITE_ID || null,
      total_programs: processedPrograms.length,
      images_found: imagesFound,
      descriptions_found: descriptionsFound,
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
    console.log('      git commit -m "Update Admitad data with real descriptions"');
    console.log('      git push');
    console.log('   2. Очистите кэш Worker:');
    console.log('      curl https://sochiautoparts.ru/api/cache/clear');

  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

main();
