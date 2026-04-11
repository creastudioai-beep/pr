// ES module syntax
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ======================== КОНФИГУРАЦИЯ ========================
const CONFIG = {
    ADMITAD_API_BASE: 'https://api.admitad.com',
    REQUEST_TIMEOUT_MS: 30000,
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,
    CONCURRENT_PROGRAM_REQUESTS: 5,   // параллельных запросов для обогащения программ
    PAGE_LIMIT: 200,                  // лимит на страницу пагинации
    LANGUAGE: 'ru',                   // язык для категорий
};

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

// ======================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ========================
function slugify(text) {
    return text.toLowerCase()
        .replace(/[^a-zа-яё0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

// Задержка для retry
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Универсальный fetch с повторными попытками и таймаутом
async function fetchWithRetry(url, options, retries = CONFIG.MAX_RETRIES) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);

            // Если 429 Too Many Requests – ждём и повторяем
            if (response.status === 429) {
                const waitTime = (i + 1) * CONFIG.RETRY_DELAY_MS;
                console.warn(`⚠️ Rate limit (429), ждём ${waitTime}ms...`);
                await delay(waitTime);
                continue;
            }

            // Любой ответ, даже с ошибкой, возвращаем – вызывающий код разберётся
            return response;
        } catch (error) {
            lastError = error;
            if (i < retries - 1) {
                console.warn(`⚠️ Ошибка запроса (попытка ${i+1}/${retries}): ${error.message}`);
                await delay(CONFIG.RETRY_DELAY_MS * (i + 1));
            }
        }
    }
    throw new Error(`Не удалось выполнить запрос после ${retries} попыток: ${lastError.message}`);
}

// Пагинированный сбор всех результатов с обработкой next
async function fetchAllPaginated(endpoint, accessToken, params = {}) {
    let allResults = [];
    let url = `${CONFIG.ADMITAD_API_BASE}/${endpoint}/?limit=${CONFIG.PAGE_LIMIT}`;
    
    // Добавляем дополнительные параметры
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            url += `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
        }
    }
    
    while (url) {
        console.log(`📡 Запрос: ${url.substring(0, 100)}...`);
        const response = await fetchWithRetry(url, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': 'SOCHIAUTOPARTS-GitHubAction/1.0',
            },
        });
        
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Ошибка ${response.status} при запросе ${endpoint}: ${errText}`);
        }
        
        const data = await response.json();
        const results = data.results || [];
        allResults.push(...results);
        url = data.next || null;
    }
    
    console.log(`✅ Загружено ${allResults.length} записей из ${endpoint}`);
    return allResults;
}

// ======================== КАТЕГОРИИ ========================
let globalCategoriesCache = null; // Map<id, categoryObject>

// Получить справочник всех категорий (один раз за сессию)
async function fetchAllCategories(accessToken) {
    if (globalCategoriesCache) return globalCategoriesCache;
    
    console.log(`📚 Загрузка справочника категорий (язык: ${CONFIG.LANGUAGE})...`);
    const allCategories = await fetchAllPaginated('categories', accessToken, {
        language: CONFIG.LANGUAGE,
    });
    
    const categoriesMap = new Map();
    for (const cat of allCategories) {
        categoriesMap.set(cat.id, cat);
    }
    globalCategoriesCache = categoriesMap;
    console.log(`✅ Загружено категорий: ${categoriesMap.size}`);
    return categoriesMap;
}

// Получить категории для одной программы (через /advcampaigns/{id}/)
async function fetchProgramCategories(programId, accessToken) {
    try {
        const response = await fetchWithRetry(
            `${CONFIG.ADMITAD_API_BASE}/advcampaigns/${programId}/?language=${CONFIG.LANGUAGE}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'User-Agent': 'SOCHIAUTOPARTS-GitHubAction/1.0',
                },
            }
        );
        if (!response.ok) return [];
        const data = await response.json();
        return data.categories || [];
    } catch (error) {
        console.warn(`⚠️ Не удалось получить категории для программы ${programId}: ${error.message}`);
        return [];
    }
}

// Fallback – старый детектор категорий по ключевым словам (на случай отсутствия API категорий)
const CATEGORY_KEYWORDS = {
    autoparts: ['автозапчасти', 'запчасти', 'auto parts', 'автодетали'],
    autoinsurance: ['страхование', 'осаго', 'каско', 'insurance', 'автострахование'],
    tires: ['шины', 'покрышки', 'tires', 'автошины', 'резина'],
    checkauto: ['проверка авто', 'автокод', 'vin', 'car check', 'история авто'],
    autorent: ['прокат авто', 'аренда авто', 'car rental', 'rent a car'],
    tools: ['инструменты', 'tools', 'автоинструмент'],
    coupons: ['купон', 'coupon', 'промокод'],
};

function detectCategoryFallback(program) {
    const text = `${program.name} ${program.description || ''}`.toLowerCase();
    for (const [catId, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
            return catId;
        }
    }
    return 'other';
}

// ======================== ТОКЕН ========================
async function fetchAccessToken() {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', clientId);
    params.append('client_secret', clientSecret);
    params.append('scope', SCOPE);
    
    console.log(`🔐 Запрос токена со scope: ${SCOPE}`);
    const response = await fetch(`${CONFIG.ADMITAD_API_BASE}/token/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'SOCHIAUTOPARTS-GitHubAction/1.0',
        },
        body: params.toString(),
    });
    
    const responseText = await response.text();
    if (!response.ok) {
        throw new Error(`Ошибка получения токена: ${responseText}`);
    }
    const data = JSON.parse(responseText);
    return data.access_token;
}

// ======================== ДАННЫЕ РЕКЛАМОДАТЕЛЯ ========================
async function fetchAdvertiserInfo(advertiserId, accessToken) {
    try {
        const response = await fetchWithRetry(
            `${CONFIG.ADMITAD_API_BASE}/advertiser/${advertiserId}/info/`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'User-Agent': 'SOCHIAUTOPARTS-GitHubAction/1.0',
                },
            }
        );
        if (!response.ok) return null;
        const data = await response.json();
        return {
            name: data.name || data.company_name || data.advertiser_name || '',
            inn: data.inn || data.tax_id || data.vat_id || '',
        };
    } catch (error) {
        console.warn(`⚠️ Ошибка запроса информации о рекламодателе ${advertiserId}: ${error.message}`);
        return null;
    }
}

// ======================== ОБРАБОТКА ПРОГРАММ ========================
async function enrichProgram(program, accessToken, categoriesMap) {
    // 1. Юридическая информация
    let legalInfo = program.advertiser_legal_info || {
        name: program.advertiser_name || program.name,
        inn: program.advertiser_inn || '',
    };
    
    if ((!legalInfo.inn || legalInfo.inn.trim() === '') && program.advertiser_id) {
        const info = await fetchAdvertiserInfo(program.advertiser_id, accessToken);
        if (info) {
            legalInfo = {
                name: legalInfo.name || info.name,
                inn: info.inn || legalInfo.inn,
            };
        }
    }
    
    // 2. Разрешённые регионы
    let allowedRegions = [];
    if (program.regions && Array.isArray(program.regions)) {
        allowedRegions = program.regions.map(r => r.region || r).filter(Boolean);
    }
    
    // 3. Категории – получаем из API
    let categoriesFromApi = [];
    let primaryCategory = { id: null, name: null };
    try {
        categoriesFromApi = await fetchProgramCategories(program.id, accessToken);
        if (categoriesFromApi && categoriesFromApi.length > 0) {
            primaryCategory = {
                id: categoriesFromApi[0].id,
                name: categoriesFromApi[0].name,
            };
        } else {
            // Fallback на старый детектор, если API категорий не вернул данные
            const fallbackId = detectCategoryFallback(program);
            primaryCategory.id = fallbackId;
            // Попробуем найти имя в загруженном справочнике
            if (categoriesMap && categoriesMap.has(fallbackId)) {
                primaryCategory.name = categoriesMap.get(fallbackId).name;
            } else {
                primaryCategory.name = fallbackId;
            }
        }
    } catch (error) {
        console.warn(`⚠️ Ошибка получения категорий для программы ${program.id}, используем fallback: ${error.message}`);
        const fallbackId = detectCategoryFallback(program);
        primaryCategory.id = fallbackId;
        if (categoriesMap && categoriesMap.has(fallbackId)) {
            primaryCategory.name = categoriesMap.get(fallbackId).name;
        } else {
            primaryCategory.name = fallbackId;
        }
        categoriesFromApi = [];
    }
    
    return {
        id: program.id,
        name: program.name,
        slug: `${slugify(program.name)}-${program.id}`,
        description: program.description || '',
        image: program.image || '',
        goto_link: program.goto_link || program.site_url,
        site_url: program.site_url,
        category_id: primaryCategory.id,
        category_name: primaryCategory.name,
        categories: categoriesFromApi, // полный массив категорий
        advertiser_legal_info: {
            name: legalInfo.name || program.name,
            inn: legalInfo.inn || '',
        },
        commission: program.commission || null,
        products_count: program.products_count || 0,
        allowed_regions: allowedRegions,
    };
}

// ======================== ГРУППИРОВКА ПО РЕГИОНАМ ========================
const REGION_GROUPS = {
    ru: { name: 'Россия', nameEn: 'Russia', countries: ['RU'] },
    cis: { name: 'СНГ', nameEn: 'CIS', countries: ['BY', 'KZ', 'AM', 'KG', 'UZ', 'TJ'] },
    global: { name: 'Глобал', nameEn: 'Global', countries: [] }
};

function groupByRegions(programs) {
    const regionGroups = {};
    for (const key of Object.keys(REGION_GROUPS)) {
        regionGroups[key] = {
            id: key,
            name: REGION_GROUPS[key].name,
            nameEn: REGION_GROUPS[key].nameEn,
            programs: [],
            count: 0,
        };
    }
    
    for (const prog of programs) {
        let assigned = false;
        for (const [groupKey, groupDef] of Object.entries(REGION_GROUPS)) {
            if (groupKey === 'global') continue;
            const hasIntersection = prog.allowed_regions.some(r => groupDef.countries.includes(r));
            if (hasIntersection) {
                regionGroups[groupKey].programs.push(prog);
                assigned = true;
                break; // первая подходящая группа
            }
        }
        if (!assigned) {
            regionGroups.global.programs.push(prog);
        }
    }
    
    // Удаляем дубликаты (хотя с break они уже не дублируются) и считаем количество
    for (const key of Object.keys(regionGroups)) {
        const unique = Array.from(new Map(regionGroups[key].programs.map(p => [p.id, p])).values());
        regionGroups[key].programs = unique;
        regionGroups[key].count = unique.length;
    }
    
    return regionGroups;
}

// ======================== КУПОНЫ ========================
// Купоны привязываются к программам после загрузки всех программ и купонов
function attachCouponsToPrograms(programs, coupons) {
    const couponsByCampaign = new Map();
    for (const coupon of coupons) {
        const campId = coupon.campaign?.id;
        if (campId) {
            if (!couponsByCampaign.has(campId)) couponsByCampaign.set(campId, []);
            couponsByCampaign.get(campId).push({
                id: coupon.id,
                name: coupon.name,
                promocode: coupon.promocode,
                description: coupon.description,
                date_start: coupon.date_start,
                date_end: coupon.date_end,
                discount: coupon.discount,
                goto_link: coupon.goto_link,
            });
        }
    }
    
    for (const prog of programs) {
        prog.coupons = couponsByCampaign.get(prog.id) || [];
    }
    return programs;
}

// ======================== MAIN ========================
async function main() {
    const startTime = Date.now();
    try {
        const accessToken = await fetchAccessToken();
        console.log('✅ Токен получен');
        
        // 1. Загружаем все программы (с пагинацией)
        const campaignParams = {};
        if (WEBSITE_ID) campaignParams.website = WEBSITE_ID;
        const allProgramsRaw = await fetchAllPaginated('advcampaigns', accessToken, campaignParams);
        console.log(`📊 Получено программ (сырых): ${allProgramsRaw.length}`);
        
        // 2. Загружаем все купоны (с пагинацией)
        let allCoupons = [];
        try {
            allCoupons = await fetchAllPaginated('coupons', accessToken, { has_affiliate_link: true, limit: 500 });
            console.log(`🎫 Получено купонов: ${allCoupons.length}`);
        } catch (err) {
            console.warn(`⚠️ Не удалось загрузить купоны: ${err.message}`);
        }
        
        // 3. Загружаем справочник категорий
        const categoriesMap = await fetchAllCategories(accessToken);
        
        // 4. Обогащаем программы категориями и юридическими данными (параллельно с ограничением)
        const enrichedPrograms = [];
        const chunks = [];
        for (let i = 0; i < allProgramsRaw.length; i += CONFIG.CONCURRENT_PROGRAM_REQUESTS) {
            chunks.push(allProgramsRaw.slice(i, i + CONFIG.CONCURRENT_PROGRAM_REQUESTS));
        }
        
        let processedCount = 0;
        for (const chunk of chunks) {
            const chunkResults = await Promise.all(
                chunk.map(prog => enrichProgram(prog, accessToken, categoriesMap))
            );
            enrichedPrograms.push(...chunkResults);
            processedCount += chunk.length;
            console.log(`⚙️ Обработано программ: ${processedCount}/${allProgramsRaw.length}`);
        }
        
        // 5. Привязываем купоны
        const programsWithCoupons = attachCouponsToPrograms(enrichedPrograms, allCoupons);
        
        // 6. Группировка по регионам
        const regionGroups = groupByRegions(programsWithCoupons);
        
        console.log(`📊 Группировка по регионам:`);
        for (const [key, group] of Object.entries(regionGroups)) {
            console.log(`   - ${group.name}: ${group.count} программ`);
        }
        
        // 7. Формируем финальный JSON
        const outputData = {
            last_updated: new Date().toISOString(),
            website_id: WEBSITE_ID || null,
            total_programs: programsWithCoupons.length,
            programs: programsWithCoupons,              // полный список
            region_groups: regionGroups,                // сгруппированные по регионам
            categories_reference: Object.fromEntries(categoriesMap), // для справки
        };
        
        // 8. Сохраняем файл
        const dataDir = path.join(__dirname, '..', 'data');
        try {
            await fs.access(dataDir);
        } catch {
            await fs.mkdir(dataDir, { recursive: true });
        }
        
        const outputPath = path.join(dataDir, 'admitad_ads.json');
        // Временная запись для атомарности
        const tmpPath = outputPath + '.tmp';
        await fs.writeFile(tmpPath, JSON.stringify(outputData, null, 2));
        await fs.rename(tmpPath, outputPath);
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`💾 Файл сохранён: ${outputPath} (за ${elapsed} с)`);
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
        process.exit(1);
    }
}

main();
