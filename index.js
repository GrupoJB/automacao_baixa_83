const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const SMB2 = require('smb2');
const util = require('util');
const os = require('os');
const { execSync } = require('child_process');
require('dotenv').config();

// Aumenta o limite de ouvintes para evitar avisos do SMB2
process.setMaxListeners(30);

// Função para limpar arquivos temporários de execuções anteriores
function cleanupTempFiles() {
    try {
        const tmpDir = os.tmpdir();
        const files = fs.readdirSync(tmpDir);
        let count = 0;
        files.forEach(file => {
            if (file.startsWith('temp_') || file.startsWith('state_') || file.startsWith('playwright_state_')) {
                try {
                    fs.unlinkSync(path.join(tmpDir, file));
                    count++;
                } catch (e) { }
            }
        });
        if (count > 0) console.log(`🧹 Limpeza local: ${count} arquivos temporários removidos.`);
    } catch (e) {
        console.error('⚠️ Erro na limpeza inicial local:', e.message);
    }
}

// Função para limpar arquivos temporários perdidos na rede (SMB)
function cleanupSmbFiles() {
    if (process.platform !== 'linux') return;
    
    console.log('🧹 Iniciando limpeza de arquivos temporários na REDE (SMB)...');
    const baseOutputPath = process.env.BASE_OUTPUT_PATH;
    const creds = `${process.env.SMB_DOMAIN}/${process.env.SMB_USER}%${process.env.SMB_PASS}`;

    for (const filial of FILIAIS) {
        try {
            const info = parsePath(path.join(baseOutputPath, filial.pasta));
            if (info.isSmb) {
                const smbPath = info.share.replace(/\\/g, '/');
                const relPath = info.relativePath.replace(/\\/g, '/');
                // Executa mdel para apagar todos os arquivos temp_*.csv na pasta da filial
                execSync(`smbclient ${smbPath} -U '${creds}' -c 'cd "${relPath}"; prompt; mdel temp_*.csv' 2>/dev/null`);
            }
        } catch (e) {
            // Silencioso se não houver arquivos ou erro de pasta
        }
    }
    console.log('✨ Faxina na rede concluída.');
}

chromium.use(stealth);

// --- CONFIGURAÇÃO DE USUÁRIOS (Sem duplicados) ---
const USERS_RAW = [
    { email: process.env.MYTRACKING_USER, pass: process.env.MYTRACKING_PASS },
    { email: 'victor.silva@transcleber.com.br', pass: 'Jbt@2024' },
    { email: 'gabriel.silva@transcleber.com.br', pass: 'Jbt@2024' }
];
const USERS = Array.from(new Set(USERS_RAW.map(u => u.email)))
    .map(email => USERS_RAW.find(u => u.email === email))
    .filter(u => u.email && u.pass);

// --- CONFIGURAÇÃO DE FILIAIS ---
const FILIAIS = [
    { nome: 'FORTALEZA', pasta: 'FOR' },
    { nome: 'IMPERATRIZ', pasta: 'IMP' },
    { nome: 'JUAZEIRO', pasta: 'JUA' },
    { nome: 'SÃO LUÍS', pasta: 'SLZ' },
    { nome: 'SOBRAL', pasta: 'SOB' },
    { nome: 'TERESINA', pasta: 'THE' }
];

let rl;
function getRL() {
    if (!rl) {
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false
        });
    }
    return rl;
}

function question(query) {
    return new Promise(resolve => getRL().question(query, resolve));
}

// --- LOGICA DE STORAGE (LOCAL OU SMB) ---
let smbClient = null;

function getSmbClient(share) {
    if (smbClient) return smbClient;
    console.log(`\n☁️ Conectando ao servidor SMB: ${share}...`);
    smbClient = new SMB2({
        share: share,
        domain: process.env.SMB_DOMAIN,
        username: process.env.SMB_USER,
        password: process.env.SMB_PASS
    });
    smbClient.existsP = util.promisify(smbClient.exists);
    smbClient.mkdirP = util.promisify(smbClient.mkdir);
    smbClient.writeFileP = util.promisify(smbClient.writeFile);
    return smbClient;
}

function parsePath(p) {
    const isSmb = p.startsWith('//') || p.startsWith('\\\\');
    if (!isSmb) return { isSmb: false, fullPath: p };
    
    const parts = p.replace(/\\/g, '/').split('/').filter(x => x);
    return {
        isSmb: true,
        share: `//${parts[0]}/${parts[1]}`,
        relativePath: parts.slice(2).join('\\'),
        filename: parts[parts.length - 1]
    };
}

const storage = {
    async mkdir(p) {
        const info = parsePath(p);
        if (info.isSmb) {
            if (process.platform === 'linux') {
                const creds = `${process.env.SMB_DOMAIN}/${process.env.SMB_USER}%${process.env.SMB_PASS}`;
                const smbPath = info.share.replace(/\\/g, '/');
                const parts = info.relativePath.split(/[\\/]/);
                let current = '';
                for (const part of parts) {
                    current = current ? current + '\\' + part : part;
                    try {
                        execSync(`smbclient ${smbPath} -U '${creds}' -c 'mkdir "${current}"' 2>/dev/null`);
                    } catch (e) {
                        // Provavelmente pasta já existe
                    }
                }
                return;
            }

            console.log(`📂 Verificando/Criando pastas no SMB: ${info.relativePath}`);
            const client = getSmbClient(info.share);
            const parts = info.relativePath.split(/[\\/]/);
            let current = '';
            for (const part of parts) {
                current = current ? path.join(current, part) : part;
                const exists = await client.existsP(current).catch(() => false);
                if (!exists) {
                    console.log(`   + Criando pasta: ${current}`);
                    await client.mkdirP(current).catch(err => {
                        console.error(`❌ Erro ao criar pasta no SMB (${current}):`, err.message);
                        throw err;
                    });
                }
            }
            return;
        }
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    },
    async save(download, p) {
        const info = parsePath(p);
        console.log(`⏳ Baixando arquivo temporário...`);
        
        const targetFilename = path.basename(p);
        const tempPath = path.join(os.tmpdir(), `temp_${Date.now()}_${targetFilename}`);
        
        try {
            await download.saveAs(tempPath);
            console.log(`✅ Download concluído localmente (${(fs.statSync(tempPath).size / 1024).toFixed(1)} KB).`);

            if (info.isSmb) {
                if (process.platform === 'linux') {
                    console.log(`📤 Enviando via smbclient...`);
                    const smbPath = info.share.replace(/\\/g, '/');
                    const remoteFile = info.relativePath.replace(/\\/g, '/') + '/' + targetFilename;
                    const creds = `${process.env.SMB_DOMAIN}/${process.env.SMB_USER}%${process.env.SMB_PASS}`;
                    
                    execSync(`smbclient ${smbPath} -U '${creds}' -c 'put "${tempPath}" "${remoteFile}"'`);
                    console.log(`✨ Arquivo enviado com sucesso para a rede!`);
                } else {
                    console.log(`📤 Enviando via SMB2 (Windows)...`);
                    const client = getSmbClient(info.share);
                    await client.writeFileP(info.relativePath + '\\' + targetFilename, fs.readFileSync(tempPath));
                    console.log(`✨ Arquivo gravado com sucesso no SMB!`);
                }
            } else {
                if (fs.existsSync(p)) fs.unlinkSync(p);
                fs.renameSync(tempPath, p);
            }
        } catch (err) {
            console.error(`❌ Erro ao salvar arquivo:`, err.message);
            throw err;
        } finally {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
                console.log(`🗑️ Temporário local removido.`);
            }
        }
    }
};

// --- LOGICA DE DATAS ---
function getPeriods(option) {
    const hoje = new Date();
    const periods = [];

    // Mes Atual (26.XX)
    const curMonth = hoje.getMonth() + 1;
    const curYear = hoje.getFullYear().toString().slice(-2);
    const tagCur = `${curYear}.${curMonth.toString().padStart(2, '0')}`;

    // Mes Passado
    const lastDate = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    const lastMonth = lastDate.getMonth() + 1;
    const lastYear = lastDate.getFullYear().toString().slice(-2);
    const tagLast = `${lastYear}.${lastMonth.toString().padStart(2, '0')}`;

    const splitLast = [
        { label: `${tagLast}.01`, start: '01', end: '15', month: lastMonth, year: lastDate.getFullYear() },
        { label: `${tagLast}.02`, start: '16', end: '31', month: lastMonth, year: lastDate.getFullYear() }
    ];

    const curFull = { label: tagCur, start: '01', end: '31', month: curMonth, year: hoje.getFullYear() };

    if (option === '1') periods.push(curFull);
    if (option === '2') periods.push(...splitLast);
    if (option === '3') periods.push(...splitLast, curFull);

    return periods;
}

// --- NAVEGAÇÃO PRINCIPAL ---
async function run(userIndex, cdIndex, periodIdx, selectedPeriods) {
    if (userIndex >= USERS.length) {
        console.error('❌ Todos os usuários atingiram o limite ou falharam.');
        process.exit(1);
    }

    if (cdIndex >= FILIAIS.length) {
        console.log('\n🏁 TODAS AS FILIAIS E PERÍODOS CONCLUÍDOS!');
        process.exit(0);
    }

    const currentUser = USERS[userIndex];
    console.log(`\n================================================`);
    console.log(`USUÁRIO: ${currentUser.email}`);
    console.log(`PROCESSO: ${FILIAIS[cdIndex].nome} (${cdIndex + 1}/${FILIAIS.length})`);
    console.log(`================================================\n`);

    const isLinux = process.platform === 'linux';
    const isHeadless = isLinux ? (process.env.HEADLESS !== 'false') : (process.env.HEADLESS === 'true');

    const browser = await chromium.launch({
        headless: isHeadless,
        args: isHeadless ? ['--no-sandbox', '--disable-setuid-sandbox'] : ['--start-maximized']
    });

    const stateFile = path.join(os.tmpdir(), `state_${currentUser.email.split('@')[0]}.json`);
    const context = await browser.newContext({
        storageState: fs.existsSync(stateFile) ? stateFile : undefined,
        acceptDownloads: true
    });

    const page = await context.newPage();

    try {
        console.log('Acessando MyTracking...');
        await page.goto(process.env.REPORT_URL, { waitUntil: 'networkidle' });

        if (page.url().includes('login.xhtml')) {
            console.log('Fazendo login...');
            await page.fill('#username', currentUser.email);
            await page.fill('#password', currentUser.pass);
            await page.click('button:has-text("Login"), #j_idt9');

            try {
                const errorMsg = page.locator('.ui-messages-error-detail, .ui-growl-item');
                if (await errorMsg.isVisible({ timeout: 5000 })) {
                    console.log(`⚠️ Erro no login: ${await errorMsg.innerText()}`);
                    await browser.close();
                    return run(userIndex + 1, cdIndex, periodIdx, selectedPeriods);
                }
            } catch (e) { }

            try {
                const popupOk = page.locator('#usuarioLogadoOK');
                await popupOk.waitFor({ state: 'visible', timeout: 5000 });
                await popupOk.click();
            } catch (e) { }

            await page.waitForURL(url => url.toString().includes('private'), { timeout: 30000 });
            await page.goto(process.env.REPORT_URL, { waitUntil: 'networkidle' });
            await context.storageState({ path: stateFile });
        }

        // Configuração de Relatório (Uma vez por login)
        console.log('Configurando filtros iniciais...');
        
        async function setupFilters(retry = true) {
            try {
                const groupTrigger = page.locator('div[id="form:grupo"] .ui-selectonemenu-trigger');
                await groupTrigger.waitFor({ state: 'visible', timeout: 120000 });
                await groupTrigger.click();
                await page.waitForTimeout(2000);
                await page.locator('.ui-selectonemenu-panel:visible li').filter({ hasText: /^14 -/ }).click();
                
                await page.waitForTimeout(3000);
                const reportTrigger = page.locator('div[id*="relatorio"] .ui-selectonemenu-trigger, .ui-selectonemenu:not(.ui-state-disabled)').last();
                await reportTrigger.waitFor({ state: 'visible', timeout: 120000 });
                await reportTrigger.click();
                await page.waitForTimeout(2000);
                await page.locator('.ui-selectonemenu-panel:visible li').filter({ hasText: /^83 -/ }).click();
                await page.waitForTimeout(5000);
            } catch (e) {
                if (retry) {
                    console.log('⚠️ Falha ao configurar filtros. Tentando recarregar a página...');
                    await page.reload({ waitUntil: 'networkidle' });
                    return setupFilters(false);
                }
                throw e;
            }
        }
        
        await setupFilters();

        for (let j = periodIdx; j < selectedPeriods.length; j++) {
            const period = selectedPeriods[j];
            console.log(`\n================================================`);
            console.log(`INICIANDO PERÍODO: ${period.label}`);
            console.log(`================================================`);

            for (let i = cdIndex; i < FILIAIS.length; i++) {
                const filial = FILIAIS[i];
                const baseOutputPath = process.env.BASE_OUTPUT_PATH;
                const sep = (baseOutputPath.startsWith('//') || baseOutputPath.startsWith('\\\\')) ? '\\' : path.sep;
                const finalPath = `${baseOutputPath}${sep}${filial.pasta}${sep}${period.label}.csv`;

                console.log(`\n>>> [${period.label}] Filial: ${filial.nome}`);

                // Configurar Filial (Com Retry para lentidão)
                async function selectFilial(retries = 2) {
                    try {
                        const unitTrigger = page.locator('div[id*="unidade"] .ui-selectonemenu-trigger');
                        await unitTrigger.waitFor({ state: 'visible', timeout: 120000 });
                        await unitTrigger.click();
                        await page.waitForTimeout(2000);
                        await page.locator('.ui-selectonemenu-panel:visible li').filter({ hasText: new RegExp(`^${filial.nome}`, 'i') }).click();
                        await page.waitForTimeout(3000);
                    } catch (e) {
                        if (retries > 0) {
                            console.log(`⚠️ Lentidão na filial ${filial.nome}. Tentando novamente...`);
                            await page.reload({ waitUntil: 'networkidle' });
                            await setupFilters(false); // Garante que os filtros 14/83 ainda estão lá
                            return selectFilial(retries - 1);
                        }
                        throw e;
                    }
                }
                await selectFilial();

                // Configurar Datas
                console.log(`Configurando datas (${period.label})...`);
                const lastDay = new Date(period.year, period.month, 0).getDate();
                const dayEnd = Math.min(parseInt(period.end), lastDay).toString().padStart(2, '0');

                await page.fill('input[id*="dataInicio_input"]', `01/${period.month.toString().padStart(2, '0')}/${period.year}`);
                await page.keyboard.press('Enter');
                await page.fill('input[id*="dataFim_input"]', `${dayEnd}/${period.month.toString().padStart(2, '0')}/${period.year}`);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(1000);

                console.log('Consultando...');
                await page.click('button:has-text("Consultar")');

                console.log('Aguardando carregamento...');
                try {
                    const limitMsg = page.locator('text=/limite de execução/i, .ui-messages-error-detail, .ui-growl-item-container').first();
                    const results = page.locator('.ui-datatable-data tr').first();
                    
                    const result = await Promise.race([
                        results.waitFor({ state: 'visible', timeout: 120000 }).then(() => 'ok'),
                        limitMsg.waitFor({ state: 'visible', timeout: 120000 }).then(() => 'limit'),
                        page.waitForTimeout(125000).then(() => 'timeout')
                    ]);

                    if (result === 'limit') {
                        throw new Error('LIMITE_ATINGIDO');
                    }
                    if (result === 'timeout') {
                        console.log('⚠️ Timeout no carregamento. Tentando próximo...');
                        continue;
                    }
                } catch (e) {
                    if (e.message === 'LIMITE_ATINGIDO') throw e;
                    console.log('⚠️ Erro ao aguardar resultados, tentando prosseguir...');
                }

                console.log('Iniciando download...');
                const [download] = await Promise.all([
                    page.waitForEvent('download', { timeout: 60000 }),
                    page.click('button[title="Exportar para CSV"]')
                ]);

                await storage.mkdir(path.dirname(finalPath));
                await storage.save(download, finalPath);
            }
            cdIndex = 0; // Reinicia filiais para o próximo período
        }

        console.log('\n🏁 TODAS AS FILIAIS E PERÍODOS CONCLUÍDOS!');
        process.exit(0);

    } catch (error) {
        if (error.message === 'LIMITE_ATINGIDO') {
            console.log('\n================================================');
            console.log('⚠️ LIMITE DIÁRIO ATINGIDO! TROCANDO DE USUÁRIO...');
            console.log('================================================\n');
            await browser.close().catch(() => { });
            return run(userIndex + 1, cdIndex, periodIdx, selectedPeriods);
        }
        
        console.error('❌ Erro crítico:', error);
        await browser.close().catch(() => { });
        if (userIndex + 1 < USERS.length) {
            console.log('🔄 Tentando recuperar com próximo usuário...');
            return run(userIndex + 1, cdIndex, periodIdx, selectedPeriods);
        }
        
        console.error('❌ Falha fatal: Todos os usuários tentados ou erro irrecuperável.');
        process.exit(1); 
    } finally {
        await browser.close().catch(() => { });
    }
}

async function start() {
    cleanupTempFiles();
    cleanupSmbFiles();
    console.log('\n======================================');
    console.log('   MYTRACKING AUTOMATION - BASE 83');
    console.log('======================================');
    console.log('1 - Baixar Mês ATUAL (Split 01 e 02)');
    console.log('2 - Baixar Mês PASSADO (Split 01 e 02)');
    console.log('3 - Baixar AMBOS (Atual + Passado)');
    
    const isInteractive = process.stdin.isTTY;
    
    let opt;
    if (!isInteractive) {
        console.log('\n🤖 Ambiente não-interativo detectado (Airflow).');
        console.log('⏩ Selecionando Opção 3 automaticamente...');
        opt = '3';
    } else {
        console.log('\n(Aguardando 15 segundos... Se nada for escolhido, a opção 3 será iniciada)');
        opt = await new Promise(resolve => {
            const timer = setTimeout(() => {
                console.log('\n⏰ Tempo esgotado! Iniciando Opção 3 por padrão...');
                resolve('3');
            }, 15000);

            getRL().question('\nEscolha uma opção: ', (answer) => {
                clearTimeout(timer);
                resolve(answer || '3');
            });
        });
    }

    const periods = getPeriods(opt);
    if (periods.length === 0) {
        console.log('Opção inválida.');
        if (rl) rl.close();
        return;
    }

    console.log(`\nPeríodos: ${periods.map(p => p.label).join(' | ')}`);
    await run(0, 0, 0, periods);
    if (rl) rl.close();
}

start();
