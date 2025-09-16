# OptBacktest (Django)

Plataforma modular de backtesting de opciones sobre acciones.

## Requisitos
- Python 3.12+ (recomendado)
- Django 5.2.x

## Entorno local
```bash
python -m venv .venv
source .venv/bin/activate         # Windows: .\.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install django python-dotenv
cp .env.example .env              # completa tus valores
python manage.py migrate
python manage.py runserver
