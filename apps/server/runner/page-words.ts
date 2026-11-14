import { type AppLocale, appLocale } from "@agenteschat/i18n/locale";

/**
 * The words of the runner's own pages (the agent's start page, a crashed tab's notice, macOS's password window for
 * Xcode). The runner carries them itself rather than the app's catalog, which it doesn't bundle.
 */

/** Any language tag (an app code, a Mac's `de-DE`) → one of the app's languages, English when none matches. */
export const pageLocale = (tag?: string | null): AppLocale => appLocale([tag], true) ?? "en";

export interface StartWords {
  title: string;
  eyebrow: string;
  exitIp: string;
  hint: string;
  tip: string;
}

export const START_WORDS: Record<AppLocale, StartWords> = {
  en: {
    title: "New Tab",
    eyebrow: "AGENT'S COMPUTER",
    exitIp: "Exit IP",
    hint: "The address sites see",
    tip: "Type an address in the bar above",
  },
  "pt-BR": {
    title: "Nova guia",
    eyebrow: "COMPUTADOR DO AGENTE",
    exitIp: "IP de saída",
    hint: "É o endereço que os sites veem",
    tip: "Digite um endereço na barra acima",
  },
  es: {
    title: "Nueva pestaña",
    eyebrow: "COMPUTADORA DEL AGENTE",
    exitIp: "IP de salida",
    hint: "La dirección que ven los sitios",
    tip: "Escribe una dirección en la barra de arriba",
  },
  fr: {
    title: "Nouvel onglet",
    eyebrow: "ORDINATEUR DE L'AGENT",
    exitIp: "IP de sortie",
    hint: "L'adresse que voient les sites",
    tip: "Saisissez une adresse dans la barre ci-dessus",
  },
  de: {
    title: "Neuer Tab",
    eyebrow: "COMPUTER DES AGENTEN",
    exitIp: "Ausgangs-IP",
    hint: "Die Adresse, die Websites sehen",
    tip: "Gib oben in der Leiste eine Adresse ein",
  },
  it: {
    title: "Nuova scheda",
    eyebrow: "COMPUTER DELL'AGENTE",
    exitIp: "IP di uscita",
    hint: "L'indirizzo che vedono i siti",
    tip: "Scrivi un indirizzo nella barra in alto",
  },
  nl: {
    title: "Nieuw tabblad",
    eyebrow: "COMPUTER VAN DE AGENT",
    exitIp: "Uitgaand IP",
    hint: "Het adres dat websites zien",
    tip: "Typ een adres in de balk hierboven",
  },
  ja: {
    title: "新しいタブ",
    eyebrow: "エージェントのコンピューター",
    exitIp: "出口IP",
    hint: "サイトから見えるアドレスです",
    tip: "上のバーにアドレスを入力してください",
  },
  ko: {
    title: "새 탭",
    eyebrow: "에이전트의 컴퓨터",
    exitIp: "출구 IP",
    hint: "사이트에 보이는 주소예요",
    tip: "위쪽 주소창에 주소를 입력하세요",
  },
  "zh-Hans": {
    title: "新标签页",
    eyebrow: "智能体的电脑",
    exitIp: "出口 IP",
    hint: "网站看到的地址",
    tip: "在上方的地址栏中输入网址",
  },
  id: {
    title: "Tab Baru",
    eyebrow: "KOMPUTER AGEN",
    exitIp: "IP keluar",
    hint: "Alamat yang dilihat situs",
    tip: "Ketik alamat di bilah atas",
  },
  tr: {
    title: "Yeni Sekme",
    eyebrow: "AJANIN BİLGİSAYARI",
    exitIp: "Çıkış IP’si",
    hint: "Sitelerin gördüğü adres",
    tip: "Yukarıdaki çubuğa bir adres yazın",
  },
  pl: {
    title: "Nowa karta",
    eyebrow: "KOMPUTER AGENTA",
    exitIp: "IP wyjściowe",
    hint: "Adres, który widzą strony",
    tip: "Wpisz adres w pasku powyżej",
  },
  ru: {
    title: "Новая вкладка",
    eyebrow: "КОМПЬЮТЕР АГЕНТА",
    exitIp: "Внешний IP",
    hint: "Адрес, который видят сайты",
    tip: "Введите адрес в строке выше",
  },
};
