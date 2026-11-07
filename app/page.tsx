import { requireChatGPTUser } from './chatgpt-auth';
import MerchantApp from './merchant-app';
export const dynamic = 'force-dynamic';
export default async function Home() { const user = await requireChatGPTUser('/'); return <MerchantApp displayName={user.displayName} />; }
