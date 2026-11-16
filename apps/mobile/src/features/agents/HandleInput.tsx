import type { Ref } from "react";
import { StyleSheet, TextInput, type TextInputInstance, View } from "react-native";
import { fieldText, GROUPED_ROW, Icon, Text } from "@/ui";
import { useColors } from "../shared/hooks";

/**
 * An agent's @ field (a new agent's, Editar's Menções), a row of a grouped list, which draws the surface: the @ drawn
 * before what is typed; `ok` checks a free @ at its end. `ref`: the field, for a form whose Next comes to it.
 */
export function HandleInput({
  value,
  onChangeText,
  label,
  placeholder,
  ok = false,
  ref,
}: {
  value: string;
  onChangeText: (value: string) => void;
  label: string;
  placeholder?: string;
  ok?: boolean;
  ref?: Ref<TextInputInstance | null>;
}) {
  const c = useColors();
  return (
    <View style={styles.row}>
      <Text variant="body" tone="faint">
        @
      </Text>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        returnKeyType="done"
        maxLength={32}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
        placeholderTextColor={c.faint}
        accessibilityLabel={label}
        style={[styles.input, fieldText("body"), { color: c.ink }]}
      />
      {ok ? <Icon name="check" size={18} color={c.ok} /> : null}
    </View>
  );
}

/** What keeps a field from going through, in the danger color, read out when it shows. */
export function ErrorLine({ text }: { text: string }) {
  const c = useColors();
  return (
    <Text variant="footnote" style={{ color: c.danger }} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
  },
  input: { flex: 1, paddingVertical: GROUPED_ROW.tallPadY },
});
