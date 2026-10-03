/// <reference types="vite/client" />

// NEW (v1.0.22) F3: типизация кастомных Vite env-переменных клиента.
// (Сам файл не обязателен — типы vite/client уже подключены в tsconfig.app.json,
//  но так переменные TURN-сервера задокументированы и строго типизированы.)
interface ImportMetaEnv {
  /** Адрес сервера мессенджера по умолчанию (http://host:port) */
  readonly VITE_SERVER_URL?: string;
  /** TURN-сервер(ы): один или несколько URL через запятую, напр.
   *  "turn:turn.example.com:3478,turns:turn.example.com:5349?transport=tcp" */
  readonly VITE_TURN_URL?: string;
  /** Логин TURN-сервера */
  readonly VITE_TURN_USERNAME?: string;
  /** Пароль TURN-сервера */
  readonly VITE_TURN_CREDENTIAL?: string;
}
