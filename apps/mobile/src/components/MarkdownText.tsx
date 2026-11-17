import React from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme';
import { parseMarkdown, type InlineSegment } from '../utils/markdown';

/** Render a secure note's Markdown as native text (no HTML, no WebView). */
export default function MarkdownText({ source, testID = 'markdown-preview' }: { source: string; testID?: string }) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return <Text style={{ color: colors.muted }}>Empty note.</Text>;
  const renderSegments = (segments: InlineSegment[]) =>
    segments.map((s, i) => (
      <Text
        key={i}
        style={{
          fontWeight: s.bold ? '700' : '400',
          fontStyle: s.italic ? 'italic' : 'normal',
          fontFamily: s.code ? 'monospace' : undefined,
          backgroundColor: s.code ? colors.input : undefined,
        }}
      >
        {s.text}
      </Text>
    ));
  return (
    <View testID={testID}>
      {blocks.map((b, i) => {
        if (b.kind === 'code') {
          return (
            <View key={i} style={{ backgroundColor: colors.input, borderRadius: 8, padding: 10, marginBottom: 8 }}>
              <Text style={{ color: colors.text, fontFamily: 'monospace', fontSize: 13 }}>{b.text}</Text>
            </View>
          );
        }
        if (b.kind === 'h1' || b.kind === 'h2' || b.kind === 'h3') {
          return (
            <Text key={i} style={{ color: colors.text, fontSize: b.kind === 'h1' ? 20 : b.kind === 'h2' ? 17 : 15, fontWeight: '700', marginBottom: 6, marginTop: i === 0 ? 0 : 8 }}>
              {renderSegments(b.segments)}
            </Text>
          );
        }
        if (b.kind === 'li') {
          return (
            <View key={i} style={{ flexDirection: 'row', marginBottom: 4, paddingLeft: 4 }}>
              <Text style={{ color: colors.muted, width: 20 }}>{b.ordered ? `${b.index}.` : '•'}</Text>
              <Text style={{ color: colors.text, fontSize: 15, flex: 1, lineHeight: 21 }}>{renderSegments(b.segments)}</Text>
            </View>
          );
        }
        return (
          <Text key={i} style={{ color: colors.text, fontSize: 15, lineHeight: 21, marginBottom: 8 }}>
            {renderSegments(b.segments)}
          </Text>
        );
      })}
    </View>
  );
}
