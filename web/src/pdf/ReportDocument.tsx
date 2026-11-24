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
    paddingTop: 42,
    paddingBottom: 52,
    paddingHorizontal: 40,
    fontFamily: 'DejaVu',
    fontSize: 9,
    lineHeight: 1.35,
    color: '#111827',
  },
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: '#cbd5e1',
    paddingTop: 5,
    fontSize: 7.5,
    color: '#475569',
  },
  runningHeader: {
    position: 'absolute',
    top: 20,
    left: 40,
    right: 40,
    fontSize: 7.5,
    color: '#64748b',
    textAlign: 'right',
  },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 2 },
  subtitle: { fontSize: 9, color: '#334155', marginBottom: 10 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 'bold',
    marginTop: 12,
    marginBottom: 5,
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    paddingBottom: 2,
  },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
  summaryItem: { width: '50%', marginBottom: 3 },
  label: { color: '#475569', fontSize: 8 },
  value: { fontSize: 9 },
  event: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 3,
    padding: 7,
    marginBottom: 7,
  },
  eventHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: '#e2e8f0',
    paddingBottom: 3,
  },
  eventDate: { fontSize: 10, fontWeight: 'bold' },
  eventTime: { fontSize: 8, color: '#334155' },
  row: { flexDirection: 'row', marginBottom: 2 },
  rowLabel: { width: 92, color: '#475569', fontSize: 8 },
  rowValue: { flex: 1, fontSize: 9 },
  notes: { marginTop: 3 },
  notice: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
    padding: 6,
    marginBottom: 10,
    fontSize: 8,
    color: '#334155',
  },
  continued: { fontSize: 9, fontWeight: 'bold', color: '#334155', marginBottom: 8 },
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
                <View style={styles.eventHeader}>
                  <Text style={styles.eventDate}>{event.reportDate}</Text>
                  <Text style={styles.eventTime}>
                    {event.occurred.timeDisplay}
                    {event.occurred.approximate ? ' approx.' : ''} · {event.occurred.zone}
                    {event.occurred.offset ? ` (${event.occurred.offset})` : ''}
                    {event.occurred.differsFromReportDate
                      ? ` · recorded ${event.occurred.date}`
                      : ''}
                  </Text>
                </View>
                {event.eventLabel ? (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Label</Text>
                    <Text style={styles.rowValue}>{event.eventLabel}</Text>
                  </View>
                ) : null}
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Precision</Text>
                  <Text style={styles.rowValue}>{event.occurred.precision}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Duration</Text>
                  <Text style={styles.rowValue}>{event.duration.label}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Affected areas</Text>
                  <Text style={styles.rowValue}>{event.affectedAreas.display}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Triggers</Text>
                  <Text style={styles.rowValue}>{event.triggers.display}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Aura / warning</Text>
                  <Text style={styles.rowValue}>{event.aura.display}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Rescue medication</Text>
                  <Text style={styles.rowValue}>{event.rescue.display}</Text>
                </View>
                {event.rescue.administrations.length > 0 ? (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Administrations</Text>
                    <View style={styles.rowValue}>
                      {event.rescue.administrations.map((administration, index) => (
                        <Text key={index}>
                          {index + 1}.{' '}
                          {[
                            administration.name ? `Name: ${administration.name}` : null,
                            administration.doseAsReported
                              ? `Dose as reported: ${administration.doseAsReported}`
                              : null,
                            administration.timingAsReported
                              ? `Timing as reported: ${administration.timingAsReported}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      ))}
                    </View>
                  </View>
                ) : null}
                {event.notes ? (
                  <View style={styles.notes}>
                    <Text style={styles.label}>Notes</Text>
                    <Text style={styles.rowValue}>{event.notes}</Text>
                  </View>
                ) : null}
              </View>
            ))}
          </>
        )}
      </Page>
    </Document>
  );
}
