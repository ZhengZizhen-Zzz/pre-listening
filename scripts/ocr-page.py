"""Read a slide image locally with macOS Vision; never performs network I/O."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.local' / 'ocr-python'))
import Vision
from Foundation import NSURL
from PIL import Image

if sys.argv[1:] == ['--probe']:
    print(json.dumps({'available': True, 'engine': 'macOS Vision'}))
    raise SystemExit
try:
    filename = sys.argv[1]
    with Image.open(filename) as im:
        if im.format not in ('JPEG', 'PNG') or max(im.size) > 4096 or im.width * im.height > 10000000:
            raise ValueError('Unsupported image dimensions or format')
        im.verify()
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setRecognitionLanguages_(['zh-Hans', 'en-US'])
    request.setUsesLanguageCorrection_(True)
    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(NSURL.fileURLWithPath_(filename), {})
    ok, error = handler.performRequests_error_([request], None)
    if not ok:
        raise RuntimeError(str(error))
    lines = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if candidates and candidates[0].confidence() >= .25:
            candidate = candidates[0]
            lines.append({'text': str(candidate.string()), 'confidence': round(float(candidate.confidence()), 3)})
    print(json.dumps({'text': '\n'.join(x['text'] for x in lines)[:12000], 'source': 'ocr', 'confidence': round(sum(x['confidence'] for x in lines) / len(lines), 3) if lines else 0}, ensure_ascii=False))
except Exception as error:
    print(str(error), file=sys.stderr)
    print(json.dumps({'error': '本页图片文字识别未完成。'}))
    raise SystemExit(1)
