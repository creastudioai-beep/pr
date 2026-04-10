// ES module syntax
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE64_HEADER = process.env.BASE64_HEADER;
const SCOPE = process.env.ADMITAD_SCOPE || 'public_data'; // <-- новый параметр

if (!BASE64_HEADER) {
  console.error('❌ Отсутствует BASE64_HEADER в переменных окружения');
  process.exit(1);
}

// Декодируем Base64, чтобы получить client_id:client_secret
let clientId, clientSecret;
try {
  const decoded = Buffer.from(BASE64_HEADER, 'base64').toString('utf8');
  const parts = decoded.split(':');
  if (parts.length !== 2) {
    throw new Error('Некорректный формат BASE64_HEADER: ожидается "client_id:client_secret"');
  }
  clientId = parts[0];
  clientSecret = parts[1];
  console.log(`🔑 Извлечён Client ID (первые 4 символа): ${clientId.substring(0, 4)}...`);
} catch (error) {
  console.error('❌ Ошибка декодирования BASE64_HEADER:', error.message);
  process.exit(1);
}

// Категории для фильтрации
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
  params.append('scope', SCOPE); // <-- добавлен scope

  console.log(`🔐 Получение токена (scope: ${SCOPE})...`);
  const response = await fetch('https://api.admitad.com/token/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SOCHIAUTOPARTS-GitHubAction/1.0',
    },
    body: params.toString(),
  });

  const responseText = await response.text();
  console.log(`📨 Ответ сервера (статус ${response.status}): ${responseText}`);

  if (!response.ok) {
    throw new Error(`Ошибка получения токена: ${responseText}`);
  }

  const data = JSON.parse(responseText);
  return data.access_token;
}

async function main() {
  try {
    const accessToken = await fetchAccessToken();
    console.log('✅ Токен получен');

    console.log('📡 Загрузка списка программ...');
    const programsResponse = await fetch(
      `https://api.admitad.com/advcampaigns/?limit=100`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': 'SOCHIAUTOPARTS-GitHubAction/1.0',
        },
      }
    );

    if (!programsResponse.ok) {
      throw new Error(`Ошибка загрузки программ: ${programsResponse.status}`);
    }

    const programsData = await programsResponse.json();
    const allPrograms = programsData.results || [];

    console.log(`📊 Всего программ: ${allPrograms.length}`);

    const filteredPrograms = [];
    for (const prog of allPrograms) {
      const category = detectCategory(prog);
      if (!category) continue;

      filteredPrograms.push({
        id: prog.id,
        name: prog.name,
        description: prog.description || '',
        image: prog.image || '',
        goto_link: prog.goto_link || prog.site_url,
        site_url: prog.site_url,
        category: category,
        advertiser_legal_info: prog.advertiser_legal_info || {
          name: prog.advertiser_name || prog.name,
          inn: prog.advertiser_inn || '',
        },
        commission: prog.commission || null,
        products_count: prog.products_count || 0,
      });
    }

    console.log(`✅ Отфильтровано: ${filteredPrograms.length}`);

    const outputData = {
      last_updated: new Date().toISOString(),
      total_programs: filteredPrograms.length,
      programs: filteredPrograms,
    };

    const dataDir = path.join(__dirname, '..', 'data');
    try { await fs.access(dataDir); } catch { await fs.mkdir(dataDir, { recursive: true }); }

    const outputPath = path.join(dataDir, 'admitad_ads.json');
    await fs.writeFile(outputPath, JSON.stringify(outputData, null, 2));

    console.log(`💾 Файл сохранён: ${outputPath}`);
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

main();
