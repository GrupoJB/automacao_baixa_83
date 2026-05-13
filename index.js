const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const path = require('path');
const fs = require('fs');
const readline = require('readline');
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

    const browser = await chromium.launch({
        headless: false,
        args: ['--start-maximized']
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
                let baseOutputPath = process.env.BASE_OUTPUT_PATH || './downloads';
                if (process.platform === 'linux' && /^[a-zA-Z]:/.test(baseOutputPath)) {
                    baseOutputPath = baseOutputPath.replace(/^[a-zA-Z]:/, '/mnt/c').replace(/\\/g, '/');
                }
                const basePath = path.join(path.resolve(baseOutputPath), filial.pasta);
                const finalPath = path.join(basePath, `${period.label}.csv`);

                if (fs.existsSync(finalPath)) {
                    const stats = fs.statSync(finalPath);
                    const diffMin = Math.round((new Date() - stats.mtime) / (1000 * 60));
                    if (diffMin < 20) {
                        console.log(`⏩ [${period.label}] ${filial.nome} já baixado há ${diffMin}min. Pulando...`);
                        continue;
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

                // Verificação de Limite
                try {
                    const limitMsg = page.locator('text=/limite de execução/i');
                    if (await limitMsg.count() > 0 && await limitMsg.first().isVisible({ timeout: 5000 })) {
                        console.log('⚠️ Limite atingido. Trocando usuário...');
                        await browser.close();
                        return run(userIndex + 1, i, j, selectedPeriods);
                    }
                } catch (e) { }

                console.log('Aguardando carregamento...');
                const loading = page.locator('.ui-dialog:visible:has-text("Carregando...")');
                await loading.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { });
                await loading.waitFor({ state: 'hidden', timeout: 180000 });

                console.log('Iniciando download...');
                await page.waitForTimeout(3000);
                const downloadBtn = page.locator('button').filter({ hasText: /^Download de Arquivo CSV - separado por ','$/ }).first();
                await downloadBtn.scrollIntoViewIfNeeded();
                await downloadBtn.waitFor({ state: 'visible', timeout: 30000 });

                const downloadPromise = page.waitForEvent('download', { timeout: 180000 });
                await downloadBtn.evaluate(el => el.click());
                const download = await downloadPromise;

                // Usar os caminhos já calculados no início do loop (basePath e finalPath)
                if (!fs.existsSync(basePath)) fs.mkdirSync(basePath, { recursive: true });
                if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
                await download.saveAs(finalPath);
                console.log(`✅ Concluído: ${finalPath}`);
            }
        }

        console.log('\n🏁 TODAS AS FILIAIS E PERÍODOS CONCLUÍDOS!');
        rl.close();

    } catch (error) {
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

    const opt = await question('\nEscolha uma opção: ');

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
