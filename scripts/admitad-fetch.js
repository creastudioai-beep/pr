// ES module syntax
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Переменные окружения
const BASE64_HEADER = process.env.BASE64_HEADER;
const WEBSITE_ID = process.env.ADMITAD_WEBSITE_ID;
const SCOPE = process.env.ADMITAD_SCOPE || 'advcampaigns coupons';

if (!BASE64_HEADER) {
  console.error('❌ Отсутствует BASE64_HEADER в переменных окружения');
  process.exit(1);
}

// Декодируем Base64 для получения client_id:client_secret
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

// Категории ключевых слов для фильтрации
const CATEGORY_KEYWORDS = {
  autoparts: ['автозапчасти', 'запчасти', 'auto parts', 'автодетали'],
  autoinsurance: ['страхование', 'осаго', 'каско', 'insurance', 'автострахование'],
  tires: ['шины', 'покрышки', 'tires', 'автошины', 'резина'],
  checkauto: ['проверка авто', 'автокод', 'vin', 'car check', 'история авто'],
  autorent: ['прокат авто', 'аренда авто', 'car rental', 'rent a car'],
  tools: ['инструменты', 'tools', 'автоинструмент'],
  coupons: ['купон', 'coupon', 'промокод'],
};

function detectCategory(program) {
  const text = `${program.name} ${program.description || ''}`.toLowerCase();
  for (const [catId, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
      return catId;
    }
  }
  return null;
}

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
      'User-Agent': 'SOCHIAUTOPARTS-GitHubAction/1.0',
    },
    body: params.toString(),
  });

  const responseText = await response.text();
  console.log(`📨 Ответ (${response.status}): ${responseText.substring(0, 100)}...`);

  if (!response.ok) {
    throw new Error(`Ошибка получения токена: ${responseText}`);
  }

  const data = JSON.parse(responseText);
  return data.access_token;
}

/**
 * Получение подробной информации о рекламодателе
 * @param {number} advertiserId - ID рекламодателя
 * @param {string} accessToken
 * @returns {Promise<{name: string, inn: string}>}
 */
async function fetchAdvertiserInfo(advertiserId, accessToken) {
  try {
    const response = await fetch(`https://api.admitad.com/advertiser/${advertiserId}/info/`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'SOCHIAUTOPARTS-GitHubAction/1.0',
      },
    });
    if (!response.ok) {
      console.warn(`⚠️ Не удалось получить данные рекламодателя ${advertiserId}: ${response.status}`);
      return null;
    }
    const data = await response.json();
    // Поля могут называться по-разному, пробуем разные варианты
    const name = data.name || data.company_name || data.advertiser_name || '';
    const inn = data.inn || data.tax_id || data.vat_id || '';
    return { name, inn };
  } catch (error) {
    console.warn(`⚠️ Ошибка запроса информации о рекламодателе ${advertiserId}: ${error.message}`);
    return null;
  }
}

async function main() {
  try {
    const accessToken = await fetchAccessToken();
    console.log('✅ Токен получен');

    // Строим URL для программ
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
        'User-Agent': 'SOCHIAUTOPARTS-GitHubAction/1.0',
      },
    });

    if (!campaignsResponse.ok) {
      const errText = await campaignsResponse.text();
      throw new Error(`Ошибка загрузки программ: ${campaignsResponse.status} - ${errText}`);
    }

    const campaignsData = await campaignsResponse.json();
    const allPrograms = campaignsData.results || [];
    console.log(`📊 Получено программ: ${allPrograms.length}`);

    // Загрузка купонов
    console.log('🎫 Загрузка купонов...');
    let allCoupons = [];
    try {
      const couponsResponse = await fetch(
        `https://api.admitad.com/coupons/?limit=500&has_affiliate_link=true`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'User-Agent': 'SOCHIAUTOPARTS-GitHubAction/1.0',
          },
        }
      );
      if (couponsResponse.ok) {
        const couponsData = await couponsResponse.json();
        allCoupons = couponsData.results || [];
        console.log(`🎫 Получено купонов: ${allCoupons.length}`);
      } else {
        console.warn(`⚠️ Не удалось загрузить купоны: ${couponsResponse.status}`);
      }
    } catch (couponError) {
      console.warn(`⚠️ Ошибка при загрузке купонов: ${couponError.message}`);
    }

    // Кэш для данных рекламодателей, чтобы не делать повторные запросы
    const advertiserCache = new Map();

    // Обогащаем программы купонами и фильтруем
    const enrichedPrograms = [];
    for (const prog of allPrograms) {
      const category = detectCategory(prog);
      if (!category) continue;

      // Получаем юридическую информацию
      let legalInfo = prog.advertiser_legal_info || {
        name: prog.advertiser_name || prog.name,
        inn: prog.advertiser_inn || '',
      };

      // Если ИНН отсутствует и есть advertiser_id, пытаемся получить через отдельный запрос
      if ((!legalInfo.inn || legalInfo.inn.trim() === '') && prog.advertiser_id) {
        const advertiserId = prog.advertiser_id;
        if (!advertiserCache.has(advertiserId)) {
          console.log(`🔍 Запрашиваем данные рекламодателя ${advertiserId}...`);
          const info = await fetchAdvertiserInfo(advertiserId, accessToken);
          advertiserCache.set(advertiserId, info);
        }
        const info = advertiserCache.get(advertiserId);
        if (info) {
          legalInfo = {
            name: legalInfo.name || info.name,
            inn: info.inn || legalInfo.inn,
          };
        }
      }

      // Ищем купоны, привязанные к данной программе
      const programCoupons = allCoupons.filter(c => c.campaign && c.campaign.id === prog.id);

      enrichedPrograms.push({
        id: prog.id,
        name: prog.name,
        description: prog.description || '',
        image: prog.image || '',
        goto_link: prog.goto_link || prog.site_url,
        site_url: prog.site_url,
        category: category,
        advertiser_legal_info: {
          name: legalInfo.name || prog.name,
          inn: legalInfo.inn || '',
        },
        commission: prog.commission || null,
        products_count: prog.products_count || 0,
        coupons: programCoupons.map(c => ({
          id: c.id,
          name: c.name,
          promocode: c.promocode,
          description: c.description,
          date_start: c.date_start,
          date_end: c.date_end,
          discount: c.discount,
          goto_link: c.goto_link,
        })),
      });
    }

    console.log(`✅ Отфильтровано программ: ${enrichedPrograms.length}`);

    const outputData = {
      last_updated: new Date().toISOString(),
      website_id: WEBSITE_ID || null,
      total_programs: enrichedPrograms.length,
      programs: enrichedPrograms,
    };

    const dataDir = path.join(__dirname, '..', 'data');
    try {
      await fs.access(dataDir);
    } catch {
      await fs.mkdir(dataDir, { recursive: true });
    }

    const outputPath = path.join(dataDir, 'admitad_ads.json');
    await fs.writeFile(outputPath, JSON.stringify(outputData, null, 2));

    console.log(`💾 Файл сохранён: ${outputPath}`);
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

main();
