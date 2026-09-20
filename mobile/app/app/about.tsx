import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import Constants from 'expo-constants';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function AboutScreen() {
  const { t } = useTranslation();
  const version = Constants.expoConfig?.version ?? '0.5.1';

  return (
    <SafeAreaView edges={['bottom']} className="flex-1 bg-gray-50 dark:bg-gray-950">
      <Stack.Screen options={{ title: t('nav.about') }} />
      <ScrollView>
        <View className="items-center bg-white dark:bg-gray-900 px-4 py-8">
          <Text className="text-3xl font-bold text-gray-900 dark:text-gray-100">Mitalivana</Text>
          <Text className="mt-1 text-sm text-gray-500 dark:text-gray-400">v{version} · {t('about.subtitle')}</Text>
        </View>

        <Section title="Author">
          <Text className="text-sm text-gray-700 dark:text-gray-300">Cheng-Tao Lin (林 政道)</Text>
          <Text className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            {'Lab of Vegetation Ecology and Spatial Information\nSchool of Forestry and Resource Conservation, NTU\n國立臺灣大學森林環境暨資源學系 植群生態與空間資訊研究室'}
          </Text>
          <Link url="https://www.mutolisp.tw" />
        </Section>
        <Section title="Data Source">
          <Text className="text-sm text-gray-700 dark:text-gray-300">
            臺灣物種名錄 TaiCOL（269824 筆學名，96677 Taxa）v2026-08-26
          </Text>
          <Link url="https://taicol.tw" />
          <Text className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            日本和名（維管束植物）：山ノ内崇志・首藤光太郎・大澤剛士・米倉浩司・加藤　将・志賀　隆 (2022)
            維管束植物和名チェックリストver. 1.10（25839 分類群，30517 和名）
          </Text>
          <Pressable
            onPress={() => Linking.openURL('https://gbif.jp/activities/checklist/wamei_checklist_110/')}
            className="mt-1 active:opacity-70"
          >
            <Text className="text-sm text-blue-600 dark:text-blue-400">
              https://gbif.jp/activities/checklist/wamei_checklist_110/
            </Text>
          </Pressable>
          <Text className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            授權：
            <Text
              className="text-blue-600 dark:text-blue-400"
              onPress={() => Linking.openURL('https://creativecommons.org/licenses/by/4.0/')}
            >
              CC-BY 4.0 International
            </Text>
          </Text>
          <Text className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            日本和名（苔蘚類）與保育屬性：米倉浩司・梶田忠 (2003-)
            BG Plants 和名－学名インデックス（YList）2021-05-14 下載版
          </Text>
          <Pressable onPress={() => Linking.openURL('http://ylist.info')} className="mt-1 active:opacity-70">
            <Text className="text-sm text-blue-600 dark:text-blue-400">http://ylist.info</Text>
          </Pressable>
          <Text className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            檢索表：王震哲、 楊智凱、 張和明、 林讚標、 王偉聿、 呂長澤、 洪鈴雅、 陳志雄、 陳志輝、 劉威廷、 鄭憲燦、 謝宗欣 (2022) 臺灣維管束植物野外鑑定指南。農業部林業及自然保育署宜蘭分署。
          </Text>
        </Section>

        <Section title={t('about.mapData')}>
          <Text className="text-sm text-gray-700 dark:text-gray-300">
            魯地圖 Taiwan TOPO（MOI.OSM）／ Rudy Map
          </Text>
          <Link url="https://rudymap.tw" />
          <Text className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            © OpenStreetMap 貢獻者（ODbL 1.0）
          </Text>
          <Link url="https://www.openstreetmap.org/copyright" />
          <Text className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            內政部 20 公尺網格數值地形模型（政府資料開放授權條款第 1 版）
          </Text>
          <Link url="https://data.gov.tw/license" />
          <Text className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            內政部國土測繪中心 WMTS 通用電子地圖
          </Text>
          <Link url="https://maps.nlsc.gov.tw" />
          <Text className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            中央研究院人社中心 GIS 專題中心「臺灣百年歷史地圖」
          </Text>
          <Link url="https://gis.sinica.edu.tw/geohistory/" />
          <Text className="mt-3 text-xs text-gray-600 dark:text-gray-400">
            {t('about.mapLicense')}
          </Text>
        </Section>

        <Section title="Development and source">
          <Text className="text-sm text-gray-700 dark:text-gray-300">Github：</Text>
          <Pressable onPress={() => Linking.openURL('https://github.com/mutolisp/mitalivana')} className="mt-1 active:opacity-70">
            <Text className="text-sm text-blue-600 dark:text-blue-400">mitalivana</Text>
          </Pressable>
        </Section>

        <Section title="License">
          <Text className="text-sm text-gray-700 dark:text-gray-300">{t('about.openSource')}</Text>
        </Section>

        <Section title={t('about.partners')}>
          <Text className="text-sm text-gray-700 dark:text-gray-300">臺灣生物多樣性機構(TaiBIF)</Text>
          <Text className="text-sm text-gray-700 dark:text-gray-300">臺灣物種名錄(TaiCOL)</Text>
          <Text className="text-sm text-gray-700 dark:text-gray-300">臺灣生物多樣性資訊聯盟(TBIA)</Text>
          <Text className="text-sm text-gray-700 dark:text-gray-300">農業部林業及自然保育署宜蘭分署</Text>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

/** A tappable external link. The about page has a dozen or so, and hand-writing
 *  the same Pressable each time is just noise. */
function Link({ url, label }: { url: string; label?: string }) {
  return (
    <Pressable onPress={() => Linking.openURL(url)} className="mt-1 active:opacity-70">
      <Text className="text-sm text-blue-600 dark:text-blue-400">{label ?? url}</Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mt-4 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3">
      <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</Text>
      {children}
    </View>
  );
}
