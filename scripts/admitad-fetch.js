// Используем встроенный fetch (доступен в Node.js 18+)
const fs = require('fs');
const path = require('path');

// Конфигурация из переменных окружения
const CLIENT_ID = process.env.ADMITAD_CLIENT_ID;
const CLIENT_SECRET = process.env.ADMITAD_CLIENT_SECRET;

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

// Функция определения категории программы по её названию и описанию
function detectCategory(program) {
  const text = `${program.name} ${program.description || ''}`.toLowerCase();
  for (const [catId, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
      return catId;
    }
  }
  return null; // не подходит ни под одну категорию
}

// Основная функция
async function main() {
  try {
    console.log('🔐 Получение access_token...');

    // Создаем base64-заголовок для Basic Auth
    const authString = `${CLIENT_ID}:${CLIENT_SECRET}`;
    const authBase64 = Buffer.from(authString).toString('base64');

    const tokenResponse = await fetch('https://api.admitad.com/token/', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authBase64}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!tokenResponse.ok) {
      throw new Error(`Ошибка получения токена: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    console.log('📡 Загрузка списка программ...');
    // Получаем программы (лимит 100)
    const programsResponse = await fetch(
      `https://api.admitad.com/advcampaigns/?limit=100`,
      {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      }
    );

    if (!programsResponse.ok) {
      throw new Error(`Ошибка загрузки программ: ${programsResponse.status}`);
    }

    const programsData = await programsResponse.json();
    const allPrograms = programsData.results || [];

    console.log(`📊 Всего получено программ: ${allPrograms.length}`);

    // Фильтруем и обогащаем данные
    const filteredPrograms = [];
    for (const prog of allPrograms) {
      const category = detectCategory(prog);
      if (!category) continue; // пропускаем нерелевантные

      // Извлекаем нужные поля
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

    // Структура финального JSON
    const outputData = {
      last_updated: new Date().toISOString(),
      total_programs: filteredPrograms.length,
      programs: filteredPrograms,
    };

    // Убедимся, что папка data существует
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const outputPath = path.join(dataDir, 'admitad_ads.json');
    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));

    console.log(`💾 Файл сохранён: ${outputPath}`);
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    process.exit(1);
  }
}

main();
