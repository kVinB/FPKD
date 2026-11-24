import { Document, Page, StyleSheet, Text, View, Font } from '@react-pdf/renderer';
import type { ReportModel } from '@shared/report';
import regularFont from '../assets/fonts/DejaVuSans.ttf';
import boldFont from '../assets/fonts/DejaVuSans-Bold.ttf';

Font.register({
  family: 'DejaVu',
  fonts: [
    { src: regularFont },
    { src: boldFont, fontWeight: 'bold' },
  ],
});

const styles = StyleSheet.create({
  page: {
    paddingTop: 30,
    paddingBottom: 38,
    paddingHorizontal: 28,
    fontFamily: 'DejaVu',
    fontSize: 7.6,
    lineHeight: 1.16,
    color: '#111827',
  },
  footer: {
    position: 'absolute',
    bottom: 16,
    left: 32,
    right: 32,
    borderTopWidth: 1,
    borderTopColor: '#cbd5e1',
    paddingTop: 4,
    fontSize: 7,
    color: '#475569',
  },
  runningHeader: {
    position: 'absolute',
    top: 16,
    left: 32,
    right: 32,
    fontSize: 7,
    color: '#64748b',
    textAlign: 'right',
  },
  title: { fontSize: 17, fontWeight: 'bold', marginBottom: 2 },
  subtitle: { fontSize: 8.5, color: '#334155', marginBottom: 8 },
  sectionTitle: {
    fontSize: 10.5,
    fontWeight: 'bold',
    marginTop: 9,
    marginBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    paddingBottom: 2,
  },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 3 },
  summaryItem: { width: '50%', marginBottom: 2 },
  label: { color: '#475569', fontSize: 7.5 },
  value: { fontSize: 8.5 },
  event: {
    borderBottomWidth: 0.5,
    borderBottomColor: '#e2e8f0',
    paddingTop: 2,
    paddingBottom: 2,
    marginBottom: 2,
  },
  eventHeaderLine: { fontSize: 8, fontWeight: 'bold', marginBottom: 0.5 },
  line: { fontSize: 7.6 },
  bold: { fontWeight: 'bold' },
  notice: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
    padding: 5,
    marginBottom: 8,
    fontSize: 7.5,
    color: '#334155',
  },
});

function medianText(value: number | null, count: number): string {
  if (value === null) return 'Not enough data';
  const whole = Number.isInteger(value);
  const text = whole
    ? value >= 60
      ? `${Math.floor(value / 60)}m ${value % 60 === 0 ? '' : `${value % 60}s`}`.trim()
      : `${value}s`
    : `${value}s`;
  return `${text} (${count} recorded)`;
}

function rescueDetail(event: ReportModel['events'][number]): string {
  if (event.rescue.administrations.length === 0) return event.rescue.display;
  const details = event.rescue.administrations
    .map((administration, index) => {
      const parts = [
        administration.name ? `Name: ${administration.name}` : null,
        administration.doseAsReported ? `Dose as reported: ${administration.doseAsReported}` : null,
        administration.timingAsReported
          ? `Timing as reported: ${administration.timingAsReported}`
          : null,
      ].filter(Boolean);
      return `${index + 1}. ${parts.join(' · ')}`;
    })
    .join('   ');
  return `${event.rescue.display} · ${details}`;
}

export function ReportDocument({ model }: { model: ReportModel }): JSX.Element {
  const { summary } = model;
  return (
    <Document
      title={`Seizure diary ${model.range.start} to ${model.range.end}`}
      author="Seizure Diary"
      subject="Patient-entered logged events"
      creator="Seizure Diary"
    >
      <Page size="A4" style={styles.page} wrap>
        <Text
          fixed
          style={styles.footer}
          render={({ pageNumber, totalPages }) =>
            `Seizure Diary · ${model.range.start} to ${model.range.end} · Page ${pageNumber} of ${totalPages}`
          }
        />
        <Text
          fixed
          style={styles.runningHeader}
          render={({ pageNumber }) => (pageNumber > 1 ? 'Seizure Diary (continued)' : '')}
        />
        <View>
          <Text style={styles.title}>Seizure Diary</Text>
          <Text style={styles.subtitle}>
            Logged events · {model.range.start} to {model.range.end} · reporting zone{' '}
            {model.reportZone}
          </Text>
          {model.patientName ? (
            <Text style={styles.subtitle}>Name: {model.patientName}</Text>
          ) : null}
          <Text style={styles.notice}>
            {model.disclaimer} Generated {model.generatedAt}. Name and notes are included only when
            opted in; this copy may contain sensitive health information.
          </Text>
        </View>

        {model.events.length === 0 ? (
          <View>
            <Text style={styles.sectionTitle}>Summary</Text>
            <Text>No events logged in this period.</Text>
          </View>
        ) : (
          <>
            <Text style={styles.sectionTitle}>Summary</Text>
            <View style={styles.summaryRow}>
              <View style={styles.summaryItem}>
                <Text style={styles.label}>Logged events</Text>
                <Text style={styles.value}>{summary.totalEvents}</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={styles.label}>Days with entries</Text>
                <Text style={styles.value}>{summary.distinctDates}</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={styles.label}>Events with rescue used</Text>
                <Text style={styles.value}>{summary.rescueUsed}</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={styles.label}>Median known duration</Text>
                <Text style={styles.value}>
                  {medianText(summary.medianDurationSeconds, summary.durationsRecorded)}
                </Text>
              </View>
            </View>

            <Text style={styles.sectionTitle}>Logged events</Text>
            {model.events.map((event) => (
              <View key={event.id} style={styles.event}>
                <Text style={styles.eventHeaderLine}>
                  {event.reportDate} · {event.occurred.timeDisplay}
                  {event.occurred.approximate ? ' approx.' : ''} · {event.occurred.zone}
                  {event.occurred.offset ? ` (${event.occurred.offset})` : ''} ·{' '}
                  {event.occurred.precision}
                  {event.occurred.differsFromReportDate
                    ? ` · recorded ${event.occurred.date}`
                    : ''}
                </Text>
                <Text style={styles.line}>
                  {event.eventLabel ? (
                    <>
                      <Text style={styles.bold}>Label:</Text> {event.eventLabel} ·{' '}
                    </>
                  ) : null}
                  <Text style={styles.bold}>Affected areas:</Text> {event.affectedAreas.display}{' '}
                  · <Text style={styles.bold}>Duration:</Text> {event.duration.label} ·{' '}
                  <Text style={styles.bold}>Triggers:</Text> {event.triggers.display} ·{' '}
                  <Text style={styles.bold}>Aura / warning:</Text> {event.aura.display} ·{' '}
                  <Text style={styles.bold}>Rescue medication:</Text> {rescueDetail(event)}
                  {event.notes ? (
                    <>
                      {' '}· <Text style={styles.bold}>Notes:</Text> {event.notes}
                    </>
                  ) : null}
                </Text>
              </View>
            ))}
          </>
        )}
      </Page>
    </Document>
  );
}
