// ES module syntax
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Конфигурация из переменных окружения
const CLIENT_ID = process.env.ADMITAD_CLIENT_ID;
const CLIENT_SECRET = process.env.ADMITAD_CLIENT_SECRET;
const SCOPE = process.env.ADMITAD_SCOPE || ''; // например, 'public_data'

// Проверка наличия секретов
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Отсутствуют ADMITAD_CLIENT_ID или ADMITAD_CLIENT_SECRET в переменных окружения');
  process.exit(1);
}

console.log(`🔑 Client ID (первые 4 символа): ${CLIENT_ID.substring(0, 4)}...`);

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
  const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
  const authBase64 = Buffer.from(authString).toString('base64');

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  if (SCOPE) params.append('scope', SCOPE);

  console.log('🔐 Попытка получения токена через Basic Auth заголовок...');
  let response = await fetch('https://api.admitad.com/token/', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${authBase64}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SOCHIAUTOPARTS-GitHubAction/1.0',
    },
    body: params.toString(),
  });

  let responseText = await response.text();
  console.log(`📨 Ответ сервера (статус ${response.status}): ${responseText}`);

  if (response.ok) {
    const data = JSON.parse(responseText);
    return data.access_token;
  }

  // Способ 2: client_id и client_secret в теле запроса
  console.log('🔐 Попытка получения токена через параметры в теле...');
  const altParams = new URLSearchParams();
  altParams.append('grant_type', 'client_credentials');
  altParams.append('client_id', CLIENT_ID);
  altParams.append('client_secret', CLIENT_SECRET);
  if (SCOPE) altParams.append('scope', SCOPE);

  response = await fetch('https://api.admitad.com/token/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SOCHIAUTOPARTS-GitHubAction/1.0',
    },
    body: altParams.toString(),
  });

  responseText = await response.text();
  console.log(`📨 Ответ сервера (статус ${response.status}): ${responseText}`);

  if (!response.ok) {
    throw new Error(`Не удалось получить токен (оба способа). Статус: ${response.status}`);
  }

  const data = JSON.parse(responseText);
  return data.access_token;
}

async function main() {
  try {
    const accessToken = await fetchAccessToken();
    console.log('✅ Токен получен успешно');

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

    console.log(`📊 Всего получено программ: ${allPrograms.length}`);

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

    console.log(`✅ Отфильтровано программ: ${filteredPrograms.length}`);

    const outputData = {
      last_updated: new Date().toISOString(),
      total_programs: filteredPrograms.length,
      programs: filteredPrograms,
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
