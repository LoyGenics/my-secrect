import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { useMobileTheme } from '../theme';
import { radius, space, textStyle } from '../ui/tokens';
import { parseMarkdown, type InlineSegment } from '../utils/markdown';

/** Render a secure note's Markdown as native text. */
export default function MarkdownText({ source, testID = 'markdown-preview' }: { source: string; testID?: string }) {
  const { colors, styles } = useMobileTheme();
  const { dict: { mobileDetail } } = useTranslation();
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return <Text style={styles.small}>{mobileDetail.emptyNote}</Text>;

  const renderSegments = (segments: InlineSegment[]) =>
    segments.map((segment, index) => (
      <Text key={index} style={[
        segment.bold && local.bold,
        segment.italic && local.italic,
        segment.code && [local.codeText, { backgroundColor: colors.surfaceMuted }],
      ]}>
        {segment.text}
      </Text>
    ));

  return (
    <View testID={testID} style={local.blocks}>
      {blocks.map((block, index) => {
        if (block.kind === 'code') {
          return (
            <View key={index} style={[local.code, { backgroundColor: colors.surfaceMuted }]}>
              <Text style={[styles.small, local.codeText, { color: colors.text }]}>{block.text}</Text>
            </View>
          );
        }
        if (block.kind === 'h1' || block.kind === 'h2' || block.kind === 'h3') {
          const headingStyle = block.kind === 'h1' ? textStyle.title : block.kind === 'h2' ? textStyle.nav : textStyle.item;
          return (
            <Text key={index} accessibilityRole="header" style={[headingStyle, { color: colors.text }]}>
              {renderSegments(block.segments)}
            </Text>
          );
        }
        if (block.kind === 'li') {
          return (
            <View key={index} style={local.listRow}>
              <Text style={[styles.body, { color: colors.secondaryText }]}>{block.ordered ? `${block.index}.` : '•'}</Text>
              <Text style={[styles.body, local.listText]}>{renderSegments(block.segments)}</Text>
            </View>
          );
        }
        return <Text key={index} style={styles.body}>{renderSegments(block.segments)}</Text>;
      })}
    </View>
  );
}

const local = StyleSheet.create({
  blocks: { gap: space[2] },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  code: { padding: space[3], borderRadius: radius.glyph },
  codeText: { fontFamily: 'monospace' },
  listRow: { flexDirection: 'row', gap: space[2] },
  listText: { flex: 1, minWidth: 0 },
});
