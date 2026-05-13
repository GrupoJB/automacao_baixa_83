const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const SMB2 = require('smb2');
const util = require('util');
const { execSync } = require('child_process');
require('dotenv').config();

chromium.use(stealth);

// --- CONFIGURAÇÃO DE USUÁRIOS ---
const USERS = [
    { email: 'luhan.vinicius@transcleber.com.br', pass: 'Luhan123@@' },
    { email: 'victor.silva@transcleber.com.br', pass: 'Victor18@' },
    { email: 'gabriel.silva@transcleber.com.br', pass: 'Gabr2312!*' }
];

// --- CONFIGURAÇÃO DE FILIAIS ---
const FILIAIS = [
    { nome: 'FORTALEZA', pasta: 'FOR' },
    { nome: 'IMPERATRIZ', pasta: 'IMP' },
    { nome: 'JUAZEIRO', pasta: 'JUA' },
    { nome: 'SÃO LUÍS', pasta: 'SLZ' },
    { nome: 'SOBRAL', pasta: 'SOB' },
    { nome: 'TERESINA', pasta: 'THE' }
];

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
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
    smbClient.unlinkP = util.promisify(smbClient.unlink);
    
    return smbClient;
}

function parsePath(fullPath) {
    const isSmb = fullPath.startsWith('//') || fullPath.startsWith('\\\\');
    if (!isSmb) return { isSmb: false, path: fullPath };

    const parts = fullPath.split(/[\\/]/).filter(Boolean);
    const host = parts[0];
    const shareName = parts[1];
    const share = `\\\\${host}\\${shareName}`;
    const relativePath = parts.slice(2).join('\\');

    return { isSmb: true, share, relativePath };
}

const storage = {
    async exists(p) {
        const info = parsePath(p);
        if (info.isSmb) {
            const client = getSmbClient(info.share);
            return await client.existsP(info.relativePath).catch(() => false);
        }
        return fs.existsSync(p);
    },
    async getMTime(p) {
        const info = parsePath(p);
        if (info.isSmb) {
            // A biblioteca SMB2 não tem um 'stat' confiável em todas as versões.
            // Retornaremos nulo para forçar o download apenas se o arquivo NÃO existir.
            return null;
        }
        const stats = fs.statSync(p);
        return stats.mtime;
    },
    async mkdir(p) {
        const info = parsePath(p);
        if (info.isSmb) {
            if (process.platform === 'linux') {
                console.log(`📂 Criando pastas via smbclient: ${info.relativePath}`);
                const smbPath = info.share.replace(/\\/g, '/');
                const relPath = info.relativePath.replace(/\\/g, '/');
                const creds = `${process.env.SMB_DOMAIN}/${process.env.SMB_USER}%${process.env.SMB_PASS}`;
                
                // Cria pastas nível por nível usando smbclient
                const parts = relPath.split('/').filter(Boolean);
                let current = '';
                for (const part of parts) {
                    current = current ? `${current}/${part}` : part;
                    try {
                        execSync(`smbclient ${smbPath} -U '${creds}' -c 'mkdir "${current}"' 2>/dev/null`);
                    } catch (e) {
                        // Pasta provavelmente já existe, ignoramos o erro
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
        const tempDir = path.join(process.cwd(), 'downloads');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const tempPath = path.join(tempDir, `temp_${Date.now()}_${path.basename(p)}`);
        
        await download.saveAs(tempPath);
        console.log(`✅ Download concluído localmente (${(fs.statSync(tempPath).size / 1024).toFixed(1)} KB).`);

        if (info.isSmb) {
            if (process.platform === 'linux') {
                console.log(`📤 Enviando via smbclient...`);
                const smbPath = info.share.replace(/\\/g, '/');
                const relPath = info.relativePath.replace(/\\/g, '/');
                const creds = `${process.env.SMB_DOMAIN}/${process.env.SMB_USER}%${process.env.SMB_PASS}`;
                
                try {
                    execSync(`smbclient ${smbPath} -U '${creds}' -c 'put "${tempPath}" "${relPath}"'`);
                    console.log(`✨ Arquivo enviado com sucesso via smbclient!`);
                    fs.unlinkSync(tempPath);
                } catch (err) {
                    console.error(`❌ ERRO NO SMBCLIENT:`, err.message);
                    throw err;
                }
                return;
            }

            console.log(`📤 Enviando para o servidor de rede (SMB2)...`);
            const client = getSmbClient(info.share);
            try {
                const content = fs.readFileSync(tempPath);
                await client.writeFileP(info.relativePath, content);
                console.log(`✨ Arquivo gravado com sucesso no SMB!`);
                fs.unlinkSync(tempPath);
            } catch (err) {
                console.error(`❌ ERRO DE ESCRITA NO SMB:`, err.message);
                throw err;
            }
        } else {
            if (fs.existsSync(p)) fs.unlinkSync(p);
            fs.renameSync(tempPath, p);
        }
    }
};

function getPeriods(option) {
    const now = new Date();
    const periods = [];

    const getMonthInfo = (date) => {
        const year = String(date.getFullYear()).slice(-2);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
        return { year, month, lastDay, fullYear: date.getFullYear(), fullMonth: date.getMonth() };
    };

    const current = getMonthInfo(now);
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = getMonthInfo(lastMonthDate);

    // Opção 2 ou 3 (Mês Passado) - Vem primeiro na opção 3
    if (option === '2' || option === '3') {
        periods.push({
            label: `${last.year}.${last.month}.01`,
            start: 1, end: 15, monthLabel: 'Passado', isLastMonth: true
        });
        periods.push({
            label: `${last.year}.${last.month}.02`,
            start: 16, end: last.lastDay, monthLabel: 'Passado', isLastMonth: true
        });
    }

    // Opção 1 ou 3 (Mês Atual)
    if (option === '1' || option === '3') {
        if (now.getDate() < 16) {
            // Se ainda não passou do dia 15, baixa o mês inteiro (ex: 26.05)
            periods.push({
                label: `${current.year}.${current.month}`,
                start: 1, end: now.getDate(), monthLabel: 'Atual'
            });
        } else {
            // Se já passou do dia 15, divide em duas partes
            periods.push({
                label: `${current.year}.${current.month}.01`,
                start: 1, end: 15, monthLabel: 'Atual'
            });
            periods.push({
                label: `${current.year}.${current.month}.02`,
                start: 16, end: now.getDate(), monthLabel: 'Atual'
            });
        }
    }

    return periods;
}

async function run(userIndex = 0, cdIndex = 0, periodIdx = 0, selectedPeriods = []) {
    if (userIndex >= USERS.length) {
        console.log('❌ Todos os usuários atingiram o limite de hoje.');
        rl.close();
        return;
    }
    if (cdIndex >= FILIAIS.length) {
        console.log('✅ Todas as filiais e períodos foram processados!');
        rl.close();
        return;
    }

    const currentUser = USERS[userIndex];
    const stateFile = `state_${currentUser.email.split('@')[0]}.json`;

    console.log(`\n================================================`);
    console.log(`USUÁRIO: ${currentUser.email}`);
    console.log(`PROCESSO: ${FILIAIS[cdIndex].nome} (${cdIndex + 1}/${FILIAIS.length})`);
    console.log(`================================================\n`);

    const isLinux = process.platform === 'linux';
    // No Linux, o padrão é true (invisível). No Windows, o padrão é false (visível).
    const isHeadless = isLinux ? (process.env.HEADLESS !== 'false') : (process.env.HEADLESS === 'true');

    const browser = await chromium.launch({
        headless: isHeadless,
        args: isHeadless ? ['--no-sandbox', '--disable-setuid-sandbox'] : ['--start-maximized']
    });

    const contextOptions = fs.existsSync(stateFile) ? { storageState: stateFile } : {};
    const context = await browser.newContext({
        ...contextOptions,
        viewport: null,
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
        await page.locator('div[id="form:grupo"] .ui-selectonemenu-trigger').click();
        await page.waitForTimeout(1000);
        await page.locator('.ui-selectonemenu-panel:visible li').filter({ hasText: /^14 -/ }).click();
        await page.waitForTimeout(2000);
        await page.locator('div[id*="relatorio"] .ui-selectonemenu-trigger, .ui-selectonemenu:not(.ui-state-disabled)').last().click();
        await page.waitForTimeout(1000);
        await page.locator('.ui-selectonemenu-panel:visible li').filter({ hasText: /^83 -/ }).click();
        await page.waitForTimeout(3000);

        for (let j = periodIdx; j < selectedPeriods.length; j++) {
            const period = selectedPeriods[j];
            console.log(`\n================================================`);
            console.log(`INICIANDO PERÍODO: ${period.label}`);
            console.log(`================================================`);

            // Recarregar a página para limpar qualquer estado anterior do calendário
            console.log('Resetando página para novo período...');
            await page.goto(process.env.REPORT_URL, { waitUntil: 'networkidle' });

            // Re-selecionar o relatório (14 e 83) após o reset
            console.log('Configurando filtros de relatório (14 e 83)...');
            await page.locator('div[id="form:grupo"] .ui-selectonemenu-trigger').click();
            await page.waitForTimeout(1000);
            await page.locator('.ui-selectonemenu-panel:visible li').filter({ hasText: /^14 -/ }).click();
            await page.waitForTimeout(2000);
            await page.locator('div[id*="relatorio"] .ui-selectonemenu-trigger, .ui-selectonemenu:not(.ui-state-disabled)').last().click();
            await page.waitForTimeout(1000);
            await page.locator('.ui-selectonemenu-panel:visible li').filter({ hasText: /^83 -/ }).click();
            await page.waitForTimeout(3000);

            let dateSet = false;

            for (let i = (j === periodIdx ? cdIndex : 0); i < FILIAIS.length; i++) {
                const filial = FILIAIS[i];

                // --- VERIFICAÇÃO INTELIGENTE DE HISTÓRICO ---
                const baseOutputPath = process.env.BASE_OUTPUT_PATH || './downloads';
                
                // No Linux, path.join colapsa // em /. Precisamos manter // para o SMB.
                const isSmb = baseOutputPath.startsWith('//') || baseOutputPath.startsWith('\\\\');
                const sep = isSmb ? (baseOutputPath.includes('\\') ? '\\' : '/') : path.sep;
                
                const finalPath = isSmb 
                    ? `${baseOutputPath}${sep}${filial.pasta}${sep}${period.label}.csv`
                    : path.join(baseOutputPath, filial.pasta, `${period.label}.csv`);

                if (await storage.exists(finalPath)) {
                    const mtime = await storage.getMTime(finalPath);
                    if (mtime) {
                        const diffMin = Math.round((new Date() - mtime) / (1000 * 60));
                        if (diffMin < 20) {
                            console.log(`⏩ [${period.label}] ${filial.nome} já baixado há ${diffMin}min. Pulando...`);
                            continue;
                        }
                    }
                }

                console.log(`\n>>> [${period.label}] Filial: ${filial.nome}`);
                await page.click('button[id="form:bt_filtro"]');
                await page.waitForTimeout(1500);

                if (!dateSet) {
                    console.log(`Configurando datas (${period.label})...`);
                    const dateInputs = page.locator('input[id$="data__input"]');

                    if (period.isLastMonth) {
                        // Como a página foi resetada, o calendário SEMPRE começa no mês atual.
                        // Para o mês passado, basta clicar em "Voltar" (prev) UMA vez.

                        await dateInputs.first().click();
                        await page.waitForTimeout(500);
                        await page.click('.ui-datepicker-prev:visible');
                        await page.waitForTimeout(500);
                        await page.click(`.ui-datepicker-calendar:visible a:text-is("${period.start}")`);

                        await dateInputs.last().click();
                        await page.waitForTimeout(500);
                        await page.click('.ui-datepicker-prev:visible');
                        await page.waitForTimeout(500);
                        await page.click(`.ui-datepicker-calendar:visible a:text-is("${period.end}")`);
                    } else {
                        // Mês Atual: Não clica em nada, seleciona direto no calendário atual
                        await dateInputs.first().click();
                        await page.waitForTimeout(500);
                        await page.click(`.ui-datepicker-calendar:visible a:text-is("${period.start}")`);
                        await page.waitForTimeout(500);
                        await dateInputs.last().click();
                        await page.waitForTimeout(500);
                        await page.click(`.ui-datepicker-calendar:visible a:text-is("${period.end}")`);
                    }
                    dateSet = true;
                }

                // Selecionar Filial
                await page.locator('label[id$=":2:mq__label"]').click();
                await page.waitForTimeout(1000);
                const panel = page.locator('.ui-selectcheckboxmenu-panel:visible');
                const allChk = panel.locator('.ui-selectcheckboxmenu-header .ui-chkbox-box');
                await allChk.click(); await page.waitForTimeout(300); await allChk.click();
                await panel.locator('li').filter({ hasText: new RegExp(`^${filial.nome}$`, 'i') }).locator('.ui-chkbox-box').click();
                await page.keyboard.press('Escape');

                console.log('Consultando...');
                await page.click('.ui-dialog:visible button:has-text("consultar")');

                console.log('Aguardando carregamento...');
                const loading = page.locator('.ui-dialog:visible:has-text("Carregando...")');
                const limitMsg = page.locator('text=/limite de execução/i')
                    .or(page.locator('.ui-messages-error-detail'))
                    .or(page.locator('.ui-growl-item-container'));
                
                // Espera o carregamento sumir OU a mensagem de limite aparecer
                await Promise.race([
                    loading.waitFor({ state: 'hidden', timeout: 180000 }),
                    limitMsg.first().waitFor({ state: 'visible', timeout: 180000 }).then(async () => {
                        const text = await limitMsg.first().innerText();
                        if (text.toLowerCase().includes('limite de execução')) {
                            throw new Error('LIMITE_ATINGIDO');
                        }
                    })
                ]).catch(err => {
                    if (err.message === 'LIMITE_ATINGIDO' || (err.message && err.message.includes('timeout'))) {
                        if (err.message === 'LIMITE_ATINGIDO') throw err;
                    }
                });

                // Checagem de segurança pós-carregamento
                if (await limitMsg.first().isVisible()) {
                    const text = await limitMsg.first().innerText();
                    if (text.toLowerCase().includes('limite de execução')) {
                        console.log('⚠️ Limite atingido detectado após carregamento.');
                        throw new Error('LIMITE_ATINGIDO');
                    }
                }

                console.log('Iniciando download...');
                await page.waitForTimeout(3000);
                const downloadBtn = page.locator('button').filter({ hasText: /^Download de Arquivo CSV - separado por ','$/ }).first();
                
                try {
                    await downloadBtn.scrollIntoViewIfNeeded();
                    await downloadBtn.waitFor({ state: 'visible', timeout: 30000 });
                } catch (e) {
                    console.log('⚠️ Botão de download não apareceu. Verificando se há dados...');
                    const noData = await page.locator('text=/nenhum registro encontrado/i').isVisible().catch(() => false);
                    if (noData) {
                        console.log('ℹ️ Nenhum dado encontrado para esta filial/período.');
                        continue;
                    }
                    throw new Error('Botão de download não encontrado após consulta.');
                }
                
                const downloadPromise = page.waitForEvent('download', { timeout: 180000 });
                await downloadBtn.evaluate(el => el.click());
                const download = await downloadPromise;
                console.log('📡 Evento de download recebido.');

                // Usar a lógica de storage unificada
                const parentDir = isSmb 
                    ? `${baseOutputPath}${sep}${filial.pasta}`
                    : path.dirname(finalPath);

                console.log(`📁 Criando diretório: ${parentDir}`);
                await storage.mkdir(parentDir);
                console.log(`💾 Salvando arquivo em: ${finalPath}`);
                await storage.save(download, finalPath);
                console.log(`✅ Concluído: ${finalPath}`);
            }
        }

        console.log('\n🏁 TODAS AS FILIAIS E PERÍODOS CONCLUÍDOS!');
        rl.close();

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
    } finally {
        await browser.close().catch(() => { });
    }
}

async function start() {
    console.log('\n======================================');
    console.log('   MYTRACKING AUTOMATION - BASE 83');
    console.log('======================================');
    console.log('1 - Baixar Mês ATUAL (Split 01 e 02)');
    console.log('2 - Baixar Mês PASSADO (Split 01 e 02)');
    console.log('3 - Baixar AMBOS (Atual + Passado)');
    console.log('\n(Aguardando 15 segundos... Se nada for escolhido, a opção 3 será iniciada)');

    let resolved = false;
    const opt = await new Promise(resolve => {
        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                console.log('\n⏰ Tempo esgotado! Iniciando Opção 3 por padrão...');
                resolve('3');
            }
        }, 15000);

        rl.question('\nEscolha uma opção: ', (answer) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                resolve(answer || '3');
            }
        });
    });

    const periods = getPeriods(opt);
    if (periods.length === 0) {
        console.log('Opção inválida.');
        rl.close();
        return;
    }

    console.log(`\nPeríodos: ${periods.map(p => p.label).join(' | ')}`);
    await run(0, 0, 0, periods);
}

start();
