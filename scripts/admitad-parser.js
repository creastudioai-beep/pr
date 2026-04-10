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

      // 🔥 ЖЁСТКАЯ ПРОВЕРКА: если ошибка — выбрасываем исключение
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: Failed to fetch programs. Response: ${errorText}`);
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
