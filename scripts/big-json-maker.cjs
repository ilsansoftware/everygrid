const fs = require('fs');
const path = require('path');

// 1GB 목표 바이트 크기 (1024 * 1024 * 1024)
const TARGET_SIZE_BYTES = 1 * 1024 * 1024 * 1024;
const FILE_PATH = path.join(__dirname, 'large_table_data.json');

const writeStream = fs.createWriteStream(FILE_PATH, { encoding: 'utf8' });

console.log('⏳ 1GB JSON 데이터 생성 시작...');

// JSON 배열 시작 괄호 작성
writeStream.write('[\n');

let currentSizeBytes = 2; // '['와 '\n' 크기 반영
let id = 1;

function writeRow() {
  let canWrite = true;

  while (currentSizeBytes < TARGET_SIZE_BYTES && canWrite) {
    // 대형 표 형태 컬럼 데이터 생성.
    // 정렬/필터 성능 측정을 위한 scalar 컬럼은 유지하고, 일부 컬럼은 중첩 객체/배열로 생성해
    // stream grid 의 object 컬럼(팝업 렌더링/인덱싱) 경로 성능을 함께 확인한다.
    const row = {
      id: id++,
      uuid: `usr_uuid_${Math.random().toString(36).substr(2, 9)}_${id}`,
      index_code: `IDX-2026-${String(id).padStart(8, '0')}`,
      username: `User_${id % 50000}`,
      email: `user_account_${id % 100000}@everygrid-performance-test.io`,
      amount: parseFloat((Math.random() * 5000000).toFixed(2)),
      is_active: id % 2 === 0,
      created_at: new Date(1767225600000 + (id * 1000)).toISOString(), // 2026년 기준 시뮬레이션
      // 중첩 객체: 부서 정보
      department: {
        name: ['Accounting', 'Financial Technology', 'Tax Strategy', 'Audit Operations', 'Risk Analytics'][id % 5],
        division: ['APAC', 'EMEA', 'Americas'][id % 3],
        headcount: (id % 200) + 1
      },
      // 중첩 객체 + 배열: 역할(직무) 정보
      role: {
        Engineering: [
          { subRole: 'Frontend', years: id % 10 },
          { subRole: 'Backend', years: (id + 3) % 10 }
        ],
        HR: [
          { subRole: 'Recruiter', years: id % 5 },
          'Public Relations'
        ]
      },
      // 중첩 객체 + 문자열 배열: 시험 결과
      examResults: {
        passed: ['Math', 'History', 'Science', 'Economics'].slice(0, (id % 4) + 1),
        failed: id % 3 === 0 ? ['English'] : []
      },
      remarks_log: "This is a high-volume systemic performance load testing row generated for Everygrid core framework capability evaluation."
    };

    // 데이터 사이에 콤마(,) 추가 판단
    let rowStr = JSON.stringify(row);
    if (currentSizeBytes > 2) {
      rowStr = ',\n' + rowStr;
    } else {
      rowStr = rowStr;
    }

    const buffer = Buffer.from(rowStr, 'utf8');
    currentSizeBytes += buffer.length;

    // 스트림 버퍼에 쓰기
    canWrite = writeStream.write(buffer);
  }

  if (currentSizeBytes >= TARGET_SIZE_BYTES) {
    // JSON 배열 닫기
    writeStream.write('\n]');
    writeStream.end();
  } else {
    // 스트림 버퍼가 가득 차면 비워질 때까지 대기 후 재개 (메모리 폭발 방지)
    writeStream.once('drain', writeRow);
  }
}

writeStream.on('finish', () => {
  const finalSizeMB = (currentSizeBytes / (1024 * 1024)).toFixed(2);
  console.log(`✨ 생성 완료!`);
  console.log(`📁 파일 경로: ${FILE_PATH}`);
  console.log(`📊 최종 용량: ${finalSizeMB} MB (정확히 1 GB 내외)`);
  console.log(`🔢 생성된 총 행(Row) 수: 약 ${id.toLocaleString()} 개`);
});

// 실행
writeRow();
