import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADMITAD_API = 'https://api.admitad.com';
const CLIENT_ID = process.env.ADMITAD_CLIENT_ID;
const CLIENT_SECRET = process.env.ADMITAD_CLIENT_SECRET;
const WEBSITE_ID = process.env.ADMITAD_WEBSITE_ID;

// Категории для распределения партнерок
const CATEGORIES = {
  autoparts: {
    name: 'Автозапчасти',
    keywords: ['запчасти', 'автозапчасти', 'parts', 'autoparts', 'exist', 'autodoc'],
    icon: '🔧'
  },
  autoinsurance: {
    name: 'Автострахование',
    keywords: ['страхование', 'осаго', 'каско', 'insurance', 'сберстрахование', 'тинькофф страхование'],
    icon: '📋'
  },
  autotires: {
    name: 'Автошины',
    keywords: ['шины', 'диски', 'tires', 'tyres', 'колеса', 'шиномонтаж'],
    icon: '🛞'
  },
  autocheck: {
    name: 'Проверка АВТО',
    keywords: ['проверка', 'автокод', 'история', 'vin', 'carfax', 'автотека'],
    icon: '🔍'
  },
  autorent: {
    name: 'Прокат АВТО',
    keywords: ['аренда', 'прокат', 'rent', 'rental', 'каршеринг'],
    icon: '🚗'
  },
  tools: {
    name: 'Инструменты',
    keywords: ['инструменты', 'tools', 'всеинструменты', '220 вольт'],
    icon: '🧰'
  },
  coupons: {
    name: 'КУПОНЫ',
    keywords: ['купон', 'скидка', 'coupon', 'promo', 'промокод'],
    icon: '🎫'
  }
};

// Приоритетные рекламодатели для горизонтальных блоков
const HORIZONTAL_ADS_PRIORITY = [
  'exist', 'autodoc', 'всеинструменты', 'сберстрахование',
  'тинькофф', 'яндекс', 'ozon', 'wildberries', 'алиэкспресс'
];

class AdmitadParser {
  constructor() {
    this.accessToken = null;
    this.programs = [];
  }

  async getToken() {
    console.log('🔑 Получение access token...');

    if (!CLIENT_ID || !CLIENT_SECRET) {
      throw new Error('Missing ADMITAD_CLIENT_ID or ADMITAD_CLIENT_SECRET');
    }

    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const response = await fetch(`${ADMITAD_API}/token/`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials&scope=advcampaigns advcampaigns_for_website public_data'
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    console.log('✅ Token получен');
    return this.accessToken;
  }

  async fetchPrograms() {
    console.log('📥 Загрузка партнерских программ...');

    let offset = 0;
    const limit = 100;
    let allPrograms = [];

    while (true) {
      const response = await fetch(
        `${ADMITAD_API}/advcampaigns/website/${WEBSITE_ID}/?limit=${limit}&offset=${offset}`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`
          }
        }
      );

      if (!response.ok) {
        console.error(`❌ Error fetching programs: ${response.status}`);
        break;
      }

      const data = await response.json();

      if (!data.results || data.results.length === 0) {
        break;
      }

      allPrograms = allPrograms.concat(data.results);
      console.log(`   Загружено: ${allPrograms.length} программ...`);

      if (data.results.length < limit) {
        break;
      }

      offset += limit;
      await new Promise(r => setTimeout(r, 200));
    }

    this.programs = allPrograms;
    console.log(`✅ Загружено ${this.programs.length} программ`);
    return this.programs;
  }

  categorizeProgram(program) {
    const text = `${program.name} ${program.description || ''} ${program.site_url || ''}`.toLowerCase();

    for (const [key, category] of Object.entries(CATEGORIES)) {
      for (const keyword of category.keywords) {
        if (text.includes(keyword.toLowerCase())) {
          return key;
        }
      }
    }

    if (program.traffics?.some(t => t.name?.toLowerCase().includes('coupon')) ||
        program.coupons) {
      return 'coupons';
    }

    return null;
  }

  parseLegalInfo(legalInfo) {
    if (!legalInfo) return null;

    try {
      const nameMatch = legalInfo.match(/\{([^}]+)\}/);
      const innMatch = legalInfo.match(/ИНН:\s*\{([^}]+)\}/);

      return {
        name: nameMatch ? nameMatch[1].trim() : null,
        inn: innMatch ? innMatch[1].trim() : null,
        raw: legalInfo
      };
    } catch {
      return { raw: legalInfo };
    }
  }

  determineRegion(program) {
    const regions = program.regions?.map(r => r.region) || [];
    const actionCountries = program.action_countries || [];
    const allRegions = [...regions, ...actionCountries];

    const hasRU = allRegions.includes('RU');
    const hasCIS = ['BY', 'KZ', 'UZ', 'KG', 'TJ', 'AM', 'AZ', 'MD'].some(c => allRegions.includes(c));
    const hasGlobal = ['US', 'DE', 'FR', 'GB', 'IT', 'ES'].some(c => allRegions.includes(c));

    return {
      ru: hasRU,
      cis: hasCIS,
      global: hasGlobal,
      all: allRegions
    };
  }

  calculatePriority(program) {
    let priority = 0;
    priority += (parseFloat(program.rating) || 0) * 10;
    priority += (parseFloat(program.ecpc) || 0) * 2;
    priority += (parseFloat(program.cr) || 0) * 0.5;
    if (program.allow_deeplink) priority += 5;
    if (program.connected) priority += 3;
    return Math.round(priority * 100) / 100;
  }

  processPrograms() {
    console.log('🔄 Обработка программ...');

    const categorized = {
      autoparts: [],
      autoinsurance: [],
      autotires: [],
      autocheck: [],
      autorent: [],
      tools: [],
      coupons: []
    };

    const horizontalAds = [];

    for (const program of this.programs) {
      if (program.status !== 'active' || program.connection_status !== 'active') {
        continue;
      }

      const category = this.categorizeProgram(program);

      const processedProgram = {
        id: program.id,
        name: program.name,
        description: program.description?.replace(/<[^>]*>/g, '').substring(0, 200) || '',
        site_url: program.site_url,
        image: program.image?.startsWith('//') ? `https:${program.image}` : program.image,
        rating: parseFloat(program.rating) || 0,
        cr: parseFloat(program.cr) || 0,
        epc: parseFloat(program.epc) || 0,
        ecpc: parseFloat(program.ecpc) || 0,
        goto_cookie_lifetime: program.goto_cookie_lifetime || 30,
        gotolink: program.gotolink || null,
        allow_deeplink: program.allow_deeplink || false,
        currency: program.currency || 'RUB',
        legal_info: this.parseLegalInfo(program.advertiser_legal_info),
        regions: this.determineRegion(program),
        actions: program.actions?.map(a => ({
          id: a.id,
          name: a.name,
          type: a.type,
          payment_size: a.payment_size
        })) || [],
        category: category,
        priority: this.calculatePriority(program)
      };

      if (category) {
        categorized[category].push(processedProgram);
      }

      const nameLower = program.name.toLowerCase();
      if (HORIZONTAL_ADS_PRIORITY.some(p => nameLower.includes(p))) {
        horizontalAds.push(processedProgram);
      }
    }

    for (const key of Object.keys(categorized)) {
      categorized[key].sort((a, b) => b.priority - a.priority);
    }
    horizontalAds.sort((a, b) => b.priority - a.priority);

    console.log('✅ Обработка завершена');

    return {
      categories: categorized,
      horizontal_ads: horizontalAds.slice(0, 20),
      stats: {
        total_programs: this.programs.length,
        active_programs: Object.values(categorized).reduce((sum, arr) => sum + arr.length, 0),
        horizontal_ads_count: horizontalAds.length,
        updated_at: new Date().toISOString()
      }
    };
  }

  async saveToFile(data) {
    const outputPath = path.join(__dirname, '..', 'public', 'admitad-data.json');
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`💾 Данные сохранены в ${outputPath}`);
    console.log(`📊 Статистика: ${JSON.stringify(data.stats, null, 2)}`);
  }

  async run() {
    try {
      await this.getToken();
      await this.fetchPrograms();
      const processed = this.processPrograms();
      await this.saveToFile(processed);
      console.log('🎉 Парсинг завершён успешно!');
    } catch (error) {
      console.error('❌ Ошибка:', error);
      process.exit(1);
    }
  }
}

const parser = new AdmitadParser();
parser.run();
