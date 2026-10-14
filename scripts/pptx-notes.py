"""Read only speaker text from a converted legacy PPT. Never extract files."""
import sys,json,zipfile,posixpath,xml.etree.ElementTree as ET

def local(tag): return tag.rsplit('}',1)[-1]
def descendants(el,name): return [x for x in el.iter() if local(x.tag)==name]
def relpath(p): return posixpath.join(posixpath.dirname(p),'_rels',posixpath.basename(p)+'.rels')
def target(source,value):
    from urllib.parse import unquote
    if not value or any(c in value for c in '\\?#'): raise ValueError('Invalid relationship')
    p=posixpath.normpath(unquote(value.lstrip('/') if value.startswith('/') else posixpath.join(posixpath.dirname(source),value)))
    if p.startswith('../') or p.startswith('/') or '\\' in p: raise ValueError('Invalid path')
    return p

def read_notes(filename):
    with zipfile.ZipFile(filename) as z:
        def xml(name):
            info=z.getinfo(name)
            if info.file_size>4*1024*1024: raise ValueError('XML limit')
            text=z.read(name)
            if b'<!DOCTYPE' in text.upper() or b'<!ENTITY' in text.upper(): raise ValueError('Invalid XML')
            return ET.fromstring(text)
        root='ppt/presentation.xml'
        slides=descendants(xml(root),'sldId');rels=descendants(xml(relpath(root)),'Relationship')
        if not 1<=len(slides)<=60: raise ValueError('Page limit')
        notes=[];failed=False;total=0
        for i,slide in enumerate(slides):
            try:
                rid=next(v for k,v in slide.attrib.items() if local(k)=='id' and 'relationships' in k)
                rel=next(r for r in rels if r.get('Id')==rid and r.get('Type','').endswith('/slide') and r.get('TargetMode')!='External')
                name=target(root,rel.get('Target'));path=relpath(name)
                if path not in z.namelist(): continue
                nr=next((r for r in descendants(xml(path),'Relationship') if r.get('Type','').endswith('/notesSlide') and r.get('TargetMode')!='External'),None)
                if nr is None: continue
                doc=xml(target(name,nr.get('Target')));paras=[]
                for shape in descendants(doc,'sp'):
                    ph=next(iter(descendants(shape,'ph')),None)
                    if ph is None or ph.get('type')!='body': continue
                    for body in descendants(shape,'txBody'):
                        for p in descendants(body,'p'):
                            paras.append(''.join('\n' if local(c.tag)=='br' else ''.join(t.text or '' for t in descendants(c,'t')) for c in p))
                text='\n'.join(paras).strip()
                if len(text)>100000 or total+len(text)>500000: raise ValueError('Notes limit')
                if text: notes.append({'page':i+1,'text':text});total+=len(text)
            except Exception: failed=True
        return {'notes':notes,'status':'partial' if failed else 'complete'}

if __name__=='__main__':
    try: result=read_notes(sys.argv[1])
    except Exception: result={'notes':[],'status':'unavailable'}
    print(json.dumps(result,ensure_ascii=False))
