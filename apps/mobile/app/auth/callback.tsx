import { ActivityIndicator, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MulticaLogo } from "@/components/brand/multica-logo";
import { Text } from "@/components/ui/text";
import { useT } from "@/lib/i18n";

export default function AuthCallback() {
  const { t } = useT("auth");
  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center gap-4 px-6">
        <MulticaLogo size={32} />
        <Text className="text-xl font-semibold text-foreground">
          {t("login.oidc_completing")}
        </Text>
        <ActivityIndicator />
      </View>
    </SafeAreaView>
  );
}
