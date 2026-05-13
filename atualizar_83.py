import os
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime
from dateutil.relativedelta import relativedelta
import unicodedata
from dotenv import load_dotenv

# Carregar variáveis de ambiente do .env
load_dotenv()

# ============ FUNÇÕES UTIL ============

def limpar_nome_coluna(col: str) -> str:
    """Normaliza cabeçalhos: remove acentos e pontuações comuns e deixa minúsculo."""
    col = unicodedata.normalize('NFKD', col).encode('ASCII', 'ignore').decode('ASCII')
    col = (col.replace('.', '')
              .replace(' ', '')
              .replace('/', '')
              .replace('-', ''))  # cobre "NF-e" e variações
    return col.lower()

def to_datetime_safe(series: pd.Series):
    """Converte para datetime sem quebrar; aceita dd/mm/aaaa."""
    return pd.to_datetime(series, errors='coerce', dayfirst=True)

def upsert_csv(cursor, df: pd.DataFrame, table: str, key_columns: list[str]):
    """UPSERT genérico usando execute_values."""
    if df.empty:
        return

    columns = [c.strip() for c in df.columns]
    values = [tuple(row) for row in df.itertuples(index=False, name=None)]

    set_clause = ', '.join([f"{col}=EXCLUDED.{col}" for col in columns if col not in key_columns])

    insert_sql = f"""
        INSERT INTO {table} ({', '.join(columns)})
        VALUES %s
        ON CONFLICT ({', '.join(key_columns)}) DO UPDATE SET
        {set_clause}
    """
    execute_values(cursor, insert_sql, values)

# ============ CONFIG ============

def get_base_path():
    path_env = os.getenv("BASE_OUTPUT_PATH")
    if not path_env:
        return "/mnt/c/Users/luhan.vinicius/grupojb.log.br/tc - DATABASE PAINEL/BASE FISCAL"
    
    # Se estiver no Linux, converte //servidor/share para /mnt/share
    if os.name == 'posix' and (path_env.startswith('//') or path_env.startswith('\\\\')):
        parts = [p for p in path_env.replace('\\', '/').split('/') if p]
        if len(parts) >= 2:
            share = parts[1]
            subpath = '/'.join(parts[2:])
            return f"/mnt/{share}/{subpath}"
    return path_env

caminho_base = get_base_path()
nome_tabela = "pedidos"
coluna_chave = ["pedido", "numero_nfe", "cod_cd"]

colunas_no_banco = [
    'id',
    'data_insercao',
    'tipo_entrega',
    'pedido',
    'data_nfe',
    'serie_nfe',
    'numero_nfe',
    'valor_nfe',
    'qtd_volumes',
    'peso',
    'remessa',
    'nome_destinatario',
    'endereco_completo',
    'cep',
    'cod_cd',
    'cd',
    'cnpj_cpf_dest',
    'transportador',
    'lead_time',
    'data_prev_entrega',
    'status_prazo',
    'id_ult_ocr',
    'ultima_ocorrencia',
    'chave_ult_ocr',
    'data_ultima_ocr',
    'agrupador',
    'endereco',
    'numero',
    'bairro',
    'cidades',
    'uf',
    'etiquetas',
    'chegada_na_transportadora',
    'cod_vendedor',
    'chave_nfe',
    'qtd_itens',
    'cpf_destinatario',
    'grau_de_risco'
]

# DE->PARA original (como vem nos arquivos). Será normalizado antes do rename.
de_para_colunas = {
    "Data Inserção": "Data_Insercao",
    "Data NFe": "Data_Nfe",                      # pode vir também como "Data Nfe"
    "Série NFe": "Serie_Nfe",
    "Peso": "Peso",
    "Remessa": "Remessa",
    "CEP": "CEP",
    "Tipo Entrega": "Tipo_Entrega",
    "Número Nfe": "Numero_Nfe",
    "Valor Nfe": "Valor_Nfe",
    "Qtd. Volumes": "Qtd_Volumes",
    "Nome Destinatário": "Nome_Destinatario",
    "Endereço Completo": "Endereco_Completo",
    "Cód. CD": "Cod_CD",
    "CD": "CD",
    "Transportador": "Transportador",
    "CNPJ/CPF Dest.": "CNPJ_CPF_Dest",
    "Lead Time": "Lead_Time",
    "Data Prev. Entrega": "Data_Prev_Entrega",
    "Data Prev. Entrega (Original)": "Data_Prev_Entrega_Original",
    "Status Prazo": "Status_Prazo",
    "ID Últ. Ocr.": "ID_Últ_Ocr",
    "Última Ocorrência": "Última_Ocorrência",
    "Chave Últ. Ocr.": "Chave_Últ_Ocr",
    "Data Última Ocr.": "Data_Última_Ocr",
    "Chegada na Transportadora": "Chegada_na_Transportadora",
    "Cod. Vendedor": "Cod_Vendedor",
    "Chave NFe": "Chave_NFe",
    "Qtd. Itens": "qtd_itens",
    "CPF Destinatário": "cpf_destinatario",
    "Grau de Risco": "grau_de_risco"
}

# Aceita arquivos dos últimos meses pelo padrão YY.MM no nome (ex: 25.08.csv ou 25.08.01.csv)
hoje = datetime.today()
tags_validas = [(hoje - relativedelta(months=i)).strftime("%y.%m") for i in range(12)]

# ============ CONEXÃO ============

conn = psycopg2.connect(
    host="192.168.10.4",
    port=5432,
    database="banco_prod",
    user="postgres",
    password="Acesso@123"
)
cursor = conn.cursor()

# ============ PROCESSAMENTO ============

try:
    for pasta in os.listdir(caminho_base):
        subcaminho = os.path.join(caminho_base, pasta)
        if not os.path.isdir(subcaminho):
            continue

        for arquivo in os.listdir(subcaminho):
            nome_sem_ext, ext = os.path.splitext(arquivo)
            if ext.lower() != ".csv":
                continue
            # Aceita se o nome for exatamente a tag ou se começar com a tag (ex: 25.08 ou 25.08.01)
            if not any(nome_sem_ext.startswith(tag) for tag in tags_validas):
                continue

            caminho_arquivo = os.path.join(subcaminho, arquivo)
            print(f"Lendo: {caminho_arquivo}")

            try:
                df = pd.read_csv(
                    caminho_arquivo,
                    sep=',',
                    encoding='ISO-8859-1',
                    quotechar='"',
                    dtype=str,
                    low_memory=False
                )

                # 1) Normalize headers do arquivo
                df.columns = [limpar_nome_coluna(c) for c in df.columns]

                # 2) Normalize DE->PARA e aplique rename
                de_para_norm = {limpar_nome_coluna(k): limpar_nome_coluna(v) for k, v in de_para_colunas.items()}
                df.rename(columns=de_para_norm, inplace=True)

                # 3) Fallbacks para data_nfe se ainda não existir
                if "data_nfe" not in df.columns:
                    for alias in ["datanfe", "datanf", "datanfemissao", "dataemissaonfe", "datanfemissao", "datanf-e"]:
                        if alias in df.columns:
                            df["data_nfe"] = df[alias]
                            print(f"✅ Mapeado '{alias}' -> 'data_nfe'")
                            break

                # 4) Se existir a coluna 'data_prev_entrega_original', ela substitui 'data_prev_entrega'
                if "data_prev_entrega_original" in df.columns:
                    df["data_prev_entrega"] = df["data_prev_entrega_original"]
                    print("✅ Usando 'Data Prev. Entrega (Original)' no lugar de 'Data Prev. Entrega'")

                # 5) Converte possíveis colunas de data
                for col_dt in ["data_ultima_ocr", "data_nfe", "data_prev_entrega", "data_insercao", "chegada_na_transportadora"]:
                    if col_dt in df.columns:
                        df[col_dt] = to_datetime_safe(df[col_dt])

                # 6) Limpeza de valores nulos e strings vazias
                df.replace({pd.NA: None, 'NaN': None, 'nan': None, '': None, ' ': None}, inplace=True)

                # 7) Garante presença das colunas-chave; se ausente, cria como 'vazio'
                for col in coluna_chave:
                    if col not in df.columns:
                        df[col] = 'vazio'
                    df[col] = df[col].fillna('vazio')

                # 8) Ordena por data_ultima_ocr desc, se existir
                if "data_ultima_ocr" in df.columns:
                    df.sort_values(by="data_ultima_ocr", ascending=False, inplace=True, na_position='last')
                else:
                    print("⚠️ Coluna 'data_ultima_ocr' não encontrada. Pulando ordenação.")

                # 9) Dedup pela chave (mantém o mais recente)
                df.drop_duplicates(subset=coluna_chave, keep='first', inplace=True)

                # 10) Mantém apenas colunas que existem no banco
                cols_validas = [c for c in df.columns if c in colunas_no_banco]
                df = df[cols_validas]

                # 11) Log mínimo
                cols_log = [c for c in (coluna_chave + ['data_ultima_ocr', 'ultima_ocorrencia', 'data_nfe']) if c in df.columns]
                if cols_log:
                    print(df[cols_log].head(5))
                else:
                    print("⚠️ Sem colunas de log para exibi r.")

                # 12) UPSERT
                upsert_csv(cursor, df, nome_tabela, coluna_chave)
                conn.commit()
                print("✅ Sucesso no UPSERT")

            except Exception as e:
                conn.rollback()
                print(f"❌ Erro no arquivo {arquivo}: {e}")

finally:
    cursor.close()
    conn.close()
    print("Conexão encerrada.")